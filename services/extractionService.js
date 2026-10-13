const Memory = require('../models/Memory');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Category = require('../models/Category');
const Suggestion = require('../models/Suggestion');
const memoryService = require('./memoryService');
const consent = require('./consentService');
const { callLlm } = require('./llm');
const retrieval = require('./retrieval');
const { validateExtraction, validateDecision } = require('./llm/schemas');
const embeddings = require('./embeddings');

// Stage 3 pipeline for one new user message (run by the job worker, never inside an API request):
//   1. EXTRACT: the LLM turns the message (plus a short window of earlier messages, for context only) into
//      candidate facts with category, importance, confidence, sensitivity and an optional validFrom.
//   2. RECONCILE: for each candidate, find similar CURRENT memories with hybrid retrieval (Stage 4: keyword +
//      vector similarity) and let the LLM decide ADD / UPDATE / SUPERSEDE / NOOP.
//   3. APPLY the decision through memoryService, so the Stage 2 versioning, transactions and audit log are
//      reused unchanged. Provenance: every memory written points at the source message.

const num = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
// Only the new message and a short window go to the model, never the whole conversation (cost grows with input)
const contextSize = () => num(process.env.EXTRACTION_CONTEXT_MESSAGES, 6);
const SIMILAR_LIMIT = 5;
const CONTEXT_CHARS = 1000; // each earlier message is cut to this length

const lower = (s) => String(s).trim().toLowerCase();

// The messages just before this one in the same conversation, oldest first.
// Uses the { conversationId, sentAt } index and stops after N rows.
async function recentWindow(message) {
  const n = contextSize();
  if (n === 0) return [];
  const rows = await Message.find({
    conversationId: message.conversationId,
    $or: [{ sentAt: { $lt: message.sentAt } }, { sentAt: message.sentAt, _id: { $lt: message._id } }],
  })
    .sort({ sentAt: -1, _id: -1 })
    .limit(n)
    .lean();
  return rows.reverse();
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ymd = (date) => date.toISOString().slice(0, 10);
const dayLabel = (date) => `${ymd(date)} (${WEEKDAYS[date.getUTCDay()]})`;

// extract.v2: the message day and the 7 days before it, each with its weekday, so the model looks up
// "last Friday" instead of computing it (14B local models got that wrong). Dates are UTC days, like sentAt.
function calendarFor(sentAt) {
  const lines = [];
  for (let back = 0; back <= 7; back += 1) {
    const day = new Date(Date.UTC(sentAt.getUTCFullYear(), sentAt.getUTCMonth(), sentAt.getUTCDate() - back));
    lines.push(`${dayLabel(day)}${back === 0 ? ' today' : back === 1 ? ' yesterday' : ''}`);
  }
  return lines.join('\n');
}

function formatRecent(messages) {
  if (messages.length === 0) return '(none)';
  return messages.map((m) => `[${m.role}] ${m.content.length > CONTEXT_CHARS ? `${m.content.slice(0, CONTEXT_CHARS)}...` : m.content}`).join('\n');
}

// Similar current memories of the same user, found with the Stage 4 hybrid retrieval: keyword matches AND
// vector similarity, so a candidate can be matched to a memory it shares no exact word with (with a semantic
// embedder). Text + vector only: recency and importance say nothing about "is this the same fact?".
// touch: false, because the extractor looking at a memory is not the user using it.
async function findSimilar(userId, candidate) {
  const search = `${candidate.content} ${candidate.topic}`.trim();
  const { results } = await retrieval.retrieve(userId, {
    query: search.slice(0, 1000),
    k: SIMILAR_LIMIT,
    weights: { text: 0.5, vector: 0.5, recency: 0, importance: 0 },
    touch: false,
  });
  return results.map((r) => r.memory);
}

// The valid-time start of an extracted fact: the date the user stated, else the moment they said it.
// A stated date in the future (or after the message) is ignored.
function factStart(candidate, message) {
  if (candidate.validFrom && candidate.validFrom <= message.sentAt) return candidate.validFrom;
  return message.sentAt;
}

async function decide(userId, candidate, similar, ctx) {
  if (similar.length === 0) {
    // Nothing to compare with: ADD without spending an LLM call
    return { action: 'ADD', targetMemoryId: null, content: candidate.content, reason: 'No similar memory exists.' };
  }
  const existing = similar.map((m) => ({
    id: String(m._id),
    content: m.content,
    tags: m.tags || [],
    category: m.categoryId ? m.categoryId.name : null,
    validFrom: m.validFrom.toISOString().slice(0, 10),
  }));
  const shown = { content: candidate.content, topic: candidate.topic, category: candidate.category, validFrom: candidate.validFrom ? candidate.validFrom.toISOString().slice(0, 10) : null };
  const data = await callLlm({
    task: 'reconcile',
    vars: { candidate: JSON.stringify(shown), existing: JSON.stringify(existing, null, 1) },
    extra: { candidate: shown, existing },
    userId,
    jobId: ctx.jobId,
  });
  return validateDecision(data, existing.map((e) => e.id));
}

// Stage 6 BASELINE ONLY ("overwrite-style memory", as most assistant memories work): an UPDATE or SUPERSEDE
// rewrites the memory in place. No new version, no closed valid time, no audit entry, so the old value is
// gone. The app itself never uses this; the evaluation compares it with the versioned pipeline above.
async function overwriteInPlace(userId, target, decision, candidate, message, fields) {
  const content = decision.content || candidate.content;
  const tags = [...new Set([...(target.tags || []), ...(candidate.topic ? [candidate.topic] : [])])];
  const sources = decision.action === 'UPDATE' ? [...new Set([...(target.sourceMessageIds || []).map(String), String(message._id)])].slice(-memoryService.MAX_SOURCES) : [String(message._id)];
  const set = { content, tags, sourceMessageIds: sources, ...(await embeddings.embeddingFields({ content, tags })) };
  // A changed fact starts when it was said; a correction keeps the old date (the same rule as the versioned pipeline)
  if (decision.action === 'SUPERSEDE') Object.assign(set, { validFrom: factStart(candidate, message), importance: fields.importance, confidence: fields.confidence, sensitivity: fields.sensitivity, categoryId: fields.categoryId });
  await Memory.updateOne({ _id: target._id, userId }, { $set: set });
  return target._id;
}

async function apply(userId, candidate, decision, similar, ctx) {
  const { message, category } = ctx;
  const options = { actorId: null, via: 'extractor', reason: decision.reason };
  const content = decision.content || candidate.content;
  const sensitivity = memoryService.SPECIAL_CATEGORIES.includes(lower(category.name)) ? 'special' : candidate.sensitivity;
  const fields = {
    categoryId: String(category._id),
    importance: candidate.importance,
    confidence: candidate.confidence,
    sensitivity,
    conversationId: String(message.conversationId),
  };
  const target = similar.find((m) => String(m._id) === decision.targetMemoryId);
  if (ctx.versioning === 'overwrite' && (decision.action === 'UPDATE' || decision.action === 'SUPERSEDE')) {
    return overwriteInPlace(userId, target, decision, candidate, message, fields);
  }

  if (decision.action === 'ADD') {
    const created = await memoryService.createMemory(
      userId,
      { ...fields, content, tags: candidate.topic ? [candidate.topic] : [], sourceMessageIds: [String(message._id)], validFrom: factStart(candidate, message) },
      options
    );
    return created._id;
  }
  if (decision.action === 'UPDATE') {
    // Same fact, more detail: a CORRECTION in Stage 2 terms (the new version takes over the old valid time).
    // Provenance keeps the old sources and adds the new message.
    const sources = [...new Set([...(target.sourceMessageIds || []).map(String), String(message._id)])].slice(-memoryService.MAX_SOURCES);
    const tags = [...new Set([...(target.tags || []), ...(candidate.topic ? [candidate.topic] : [])])];
    const version = await memoryService.updateMemory(userId, decision.targetMemoryId, { content, tags, sourceMessageIds: sources, correction: true }, options);
    return version._id;
  }
  if (decision.action === 'SUPERSEDE') {
    // The world changed: the old version's valid time ends where the new fact starts. That start must be
    // after the old version's start; if the stated date is not, use the message time, else now.
    let validFrom = factStart(candidate, message);
    if (validFrom <= target.validFrom) validFrom = message.sentAt > target.validFrom ? message.sentAt : new Date();
    const version = await memoryService.updateMemory(
      userId,
      decision.targetMemoryId,
      { ...fields, content, tags: candidate.topic ? [candidate.topic] : [], sourceMessageIds: [String(message._id)], validFrom },
      options
    );
    return version._id;
  }
  return null; // NOOP: nothing is written
}

// Stage 7: stores a candidate as a pending suggestion. An upsert on (user, message, content), so a retried
// job does not suggest the same fact twice.
async function suggest(userId, candidate, { message, category }) {
  const sensitivity = memoryService.SPECIAL_CATEGORIES.includes(lower(category.name)) ? 'special' : candidate.sensitivity;
  const key = { userId, messageId: message._id, content: candidate.content };
  const fields = {
    conversationId: message.conversationId,
    categoryId: category._id,
    topic: candidate.topic || null,
    importance: candidate.importance,
    confidence: candidate.confidence,
    sensitivity,
    validFrom: factStart(candidate, message),
  };
  return Suggestion.findOneAndUpdate(key, { $setOnInsert: { ...key, ...fields } }, { upsert: true, new: true, runValidators: true });
}

// Runs the pipeline for one message and returns a summary (stored on the job). Throws on LLM or database
// errors so the worker can retry the job.
// versioning: 'bitemporal' (the app, always) or 'overwrite' (the Stage 6 baseline, see overwriteInPlace).
const VERSIONING = ['bitemporal', 'overwrite'];
// extractionCache (Stage 6 only): a Map shared by several memory stores built from the same benchmark messages,
// so every store receives the SAME extracted facts (one paid extraction call per message, not one per store)
// and the stores differ only in how they reconcile and store them.
async function processMessage({ userId, messageId, conversationId, jobId = null }, { versioning = 'bitemporal', extractionCache = null } = {}) {
  if (!VERSIONING.includes(versioning)) throw new Error(`versioning must be one of: ${VERSIONING.join(', ')}`);
  const conversation = await Conversation.findOne({ _id: conversationId, userId }).select('_id').lean();
  const message = conversation ? await Message.findOne({ _id: messageId, conversationId }).lean() : null;
  if (!message) return { skipped: 'The message or its conversation no longer exists', decisions: [] };
  if (message.role !== 'user') return { skipped: 'Only user messages are mined for facts', decisions: [] };

  const categories = await Category.find().select('name').sort({ name: 1 }).lean();
  const recent = await recentWindow(message);
  const cacheKey = extractionCache && message.source && message.source.id ? `${message.source.id}|${message.sentAt.toISOString()}` : null;
  let data = cacheKey ? extractionCache.get(cacheKey) : undefined;
  if (data === undefined) {
    data = await callLlm({
      task: 'extract',
      vars: {
        categories: categories.map((c) => c.name).join(', ') || '(none)',
        recent: formatRecent(recent),
        sentAt: ymd(message.sentAt), // extract.v1
        sentDay: dayLabel(message.sentAt), // extract.v2
        calendar: calendarFor(message.sentAt), // extract.v2
        message: message.content,
      },
      extra: { message: message.content },
      userId,
      jobId,
    });
    if (cacheKey) extractionCache.set(cacheKey, data);
  }
  const { candidates, rejected } = validateExtraction(data);

  // A retried job must not apply the same fact twice: facts already stored from this message are skipped
  const fromThisMessage = await Memory.find({ userId, ...memoryService.CURRENT, sourceMessageIds: message._id }).select('content').lean();
  const alreadyStored = new Set(fromThisMessage.map((m) => lower(m.content)));

  const decisions = [];
  for (const candidate of candidates) {
    const category = categories.find((c) => lower(c.name) === lower(candidate.category));
    const base = { category: candidate.category, topic: candidate.topic };
    if (!category) {
      decisions.push({ ...base, action: 'SKIP', reason: `Unknown category "${candidate.category}"` });
      continue;
    }
    // Stage 7: per-category consent. "never" drops the fact before any reconciliation call is paid for;
    // "ask" keeps it as a suggestion the user accepts or rejects (it is not a memory until then).
    const mode = await consent.modeFor(userId, category._id);
    if (mode === 'never') {
      decisions.push({ ...base, action: 'SKIP', reason: 'The user has not consented to storing this category' });
      continue;
    }
    if (mode === 'ask') {
      const suggestion = await suggest(userId, candidate, { message, category });
      decisions.push({ ...base, action: 'ASK', suggestionId: suggestion._id, reason: 'The user asked to confirm facts in this category first' });
      continue;
    }
    if (alreadyStored.has(lower(candidate.content))) {
      decisions.push({ ...base, action: 'SKIP', reason: 'Already stored from this message (job retry)' });
      continue;
    }
    const similar = await findSimilar(userId, candidate);
    const decision = await decide(userId, candidate, similar, { jobId });
    const memoryId = await apply(userId, candidate, decision, similar, { message, category, versioning });
    if (decision.action !== 'NOOP') alreadyStored.add(lower(decision.content || candidate.content));
    decisions.push({ ...base, action: decision.action, memoryId, targetMemoryId: decision.targetMemoryId, reason: decision.reason });
  }
  return { messageId: message._id, candidates: candidates.length, rejected, decisions };
}

module.exports = { processMessage, recentWindow, findSimilar, calendarFor };
