// Stage 6 evaluation harness: answers LoCoMo questions with every system in eval/systems.js and scores them.
// evaluateSample() expects an EMPTY database (eval/run.js drops a disposable one before each sample; the tests
// clear the test database). The gold answers stay in memory here and are never written next to the chat data,
// so they cannot leak into memories or retrieval.
const mongoose = require('mongoose');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Memory = require('../models/Memory');
const AuditLog = require('../models/AuditLog');
const LlmCall = require('../models/LlmCall');
const { buildSample } = require('../services/datasets/locomo');
const { ensureCategories } = require('../services/datasets/synthetic');
const { createRng } = require('../services/datasets/common');
const { processMessage } = require('../services/extractionService');
const { callLlmDetailed } = require('../services/llm');
const { locomoScore, recallAtK } = require('./metrics');
const S = require('./systems');

const NO_INFO = 'No information available';
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;

// Picks up to n questions of a sample, spread over the question categories (round robin over the categories
// in a seeded order), so a small pilot still sees every question type. Returns qa indexes.
function pickQuestions(qa, n, seed = 1) {
  if (!n || n >= qa.length) return qa.map((_, i) => i);
  const rng = createRng(seed);
  const byCat = new Map();
  qa.forEach((q, i) => byCat.set(q.category, [...(byCat.get(q.category) || []), i]));
  const queues = [...byCat.keys()].sort((a, b) => a - b).map((c) => {
    const list = [...byCat.get(c)];
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = rng.int(0, i);
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  });
  const out = [];
  while (out.length < n) {
    for (const q of queues) if (q.length && out.length < n) out.push(q.shift());
  }
  return out.sort((a, b) => a - b);
}

// The mirror perspective: the same sessions and turns, owned by a second user, with the roles swapped, so the
// second speaker's turns are the 'user' messages that the extractor mines.
function mirror(built, speakerB) {
  const userId = new mongoose.Types.ObjectId();
  const user = { ...built.user, _id: userId, name: `${speakerB} (mirror of ${built.user.name})`, email: built.user.email.replace('@', '+b@'), source: { ...built.user.source, id: `${built.user.source.id}#b` } };
  const convIds = new Map(built.conversations.map((c) => [String(c._id), new mongoose.Types.ObjectId()]));
  const conversations = built.conversations.map((c) => ({ ...c, _id: convIds.get(String(c._id)), userId }));
  const messages = built.messages.map((m) => ({ ...m, _id: new mongoose.Types.ObjectId(), conversationId: convIds.get(String(m.conversationId)), role: m.role === 'user' ? 'assistant' : 'user' }));
  return { user, conversations, messages };
}

// Builds one memory store: every message is mined once, by the perspective of its speaker, in time order.
async function buildStore(perspectives, versioning, extractionCache) {
  const started = Date.now();
  const queue = [];
  for (const p of perspectives) for (const m of p.messages) if (m.role === 'user') queue.push({ p, m });
  queue.sort((a, b) => a.m.sentAt - b.m.sentAt);
  const actions = {};
  for (const { p, m } of queue) {
    const result = await processMessage({ userId: p.userId, messageId: m._id, conversationId: m.conversationId }, { versioning, extractionCache });
    for (const d of result.decisions) actions[d.action] = (actions[d.action] || 0) + 1;
  }
  const userIds = perspectives.map((p) => p.userId);
  const [stats] = await Memory.aggregate([
    { $match: { userId: { $in: userIds } } },
    { $group: { _id: null, versions: { $sum: 1 }, current: { $sum: { $cond: [{ $and: [{ $eq: ['$validTo', null] }, { $eq: ['$retractedAt', null] }] }, 1, 0] } }, bytes: { $sum: { $bsonSize: '$$ROOT' } } } },
  ]);
  const calls = await LlmCall.aggregate([
    { $match: { userId: { $in: userIds }, at: { $gte: new Date(started) } } },
    { $group: { _id: '$task', calls: { $sum: 1 }, inputTokens: { $sum: '$inputTokens' }, outputTokens: { $sum: '$outputTokens' }, costUsd: { $sum: '$costUsd' } } },
  ]);
  const byTask = Object.fromEntries(calls.map((c) => [c._id, c]));
  return {
    store: versioning,
    messages_mined: queue.length,
    decisions: Object.entries(actions).map(([a, n]) => `${a}=${n}`).sort().join(' '),
    memory_versions: stats ? stats.versions : 0,
    memory_current: stats ? stats.current : 0,
    memory_bytes: stats ? stats.bytes : 0,
    extract_calls: byTask.extract ? byTask.extract.calls : 0,
    reconcile_calls: byTask.reconcile ? byTask.reconcile.calls : 0,
    build_input_tokens: calls.reduce((s, c) => s + (c.inputTokens || 0), 0),
    build_output_tokens: calls.reduce((s, c) => s + (c.outputTokens || 0), 0),
    build_cost_usd: calls.reduce((s, c) => s + (c.costUsd || 0), 0),
    build_seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

async function clearStore(userIds) {
  await Memory.deleteMany({ userId: { $in: userIds } });
  await AuditLog.deleteMany({ userId: { $in: userIds } });
}

// One answer + one judge verdict for (system, question)
async function answerAndScore({ system, item, context, asOf, retrievalMs }) {
  const gold = item.answer === null ? NO_INFO : item.answer;
  const contextText = context.items.map((i) => i.text).join('\n') || '(nothing retrieved)';
  const answered = await callLlmDetailed({
    task: 'eval_answer',
    vars: { asOf: asOf.toISOString().slice(0, 10), contextKind: context.kind, context: contextText, question: item.question },
    extra: { question: item.question, items: context.items },
    cachePrefix: system.id === 'full_context',
  });
  const judged = await callLlmDetailed({
    task: 'judge',
    vars: { question: item.question, gold, candidate: answered.data.answer },
    extra: { gold: item.answer, candidate: answered.data.answer },
  });
  const covered = context.items.flatMap((i) => i.dia);
  const usage = answered.usage || {};
  return {
    sample: item.sampleId,
    qa_index: item.index,
    category: item.category,
    question_type: item.questionType,
    system: system.id,
    question: item.question,
    gold,
    answer: answered.data.answer,
    insufficient: answered.data.insufficient,
    cited: (answered.data.citedMemories || []).join(' '),
    score_f1: Math.round(locomoScore(answered.data.answer, item) * 1e4) / 1e4,
    judge_correct: judged.data.correct ? 1 : 0,
    judge_reason: judged.data.reason,
    recall_at_k: recallAtK(item.evidence, covered),
    context_items: context.items.length,
    context_dia: [...new Set(covered)].join(' '),
    context_tokens_est: S.estimateTokens(contextText),
    retrieval_ms: Math.round(retrievalMs * 100) / 100,
    answer_ms: answered.latencyMs,
    judge_ms: judged.latencyMs,
    input_tokens: usage.inputTokens || 0,
    output_tokens: usage.outputTokens || 0,
    cache_read_tokens: usage.cacheReadTokens || 0,
    cache_write_tokens: usage.cacheWriteTokens || 0,
    tokens_estimated: answered.tokensEstimated,
    answer_cost_usd: answered.costUsd,
    judge_cost_usd: judged.costUsd,
    provider: answered.provider,
    model: answered.model,
    judge_model: judged.model,
  };
}

// Runs every requested system on the chosen questions of one LoCoMo sample.
// Returns { rows, builds } (rows: one per system x question; builds: one per memory store + raw storage).
async function evaluateSample(sample, { questions = 10, k = 10, systems = S.SYSTEM_IDS, seed = 1, log = () => {} } = {}) {
  const chosen = systems.map((id) => {
    const s = S.SYSTEMS.find((x) => x.id === id);
    if (!s) throw new Error(`Unknown system "${id}" (known: ${S.SYSTEM_IDS.join(', ')})`);
    return s;
  });
  await ensureCategories();
  const built = buildSample(sample);
  const { speaker_a: speakerA, speaker_b: speakerB } = sample.conversation;
  const mirrored = mirror(built, speakerB);
  for (const part of [built, mirrored]) {
    await User.create(part.user);
    await Conversation.insertMany(part.conversations);
    await Message.insertMany(part.messages);
  }
  const perspectives = [
    { userId: built.user._id, person: speakerA, messages: built.messages },
    { userId: mirrored.user._id, person: speakerB, messages: mirrored.messages },
  ];
  const messages = [...built.messages].sort((a, b) => a.sentAt - b.sentAt);
  const sources = new Map([...built.messages, ...mirrored.messages].map((m) => [String(m._id), m]));
  // The question date: the day after the last session (LoCoMo questions are asked after the conversation)
  const asOf = new Date(messages[messages.length - 1].sentAt.getTime() + 86400000);
  // Evidence as dialog ids, keeping only the ids that match a loaded turn (Stage 5 lists the others apart)
  const items = pickQuestions(sample.qa, questions, seed).map((i) => {
    const item = built.evalItems[i];
    return { ...item, index: i, sampleId: sample.sample_id, evidence: item.evidenceMessageIds.map((id) => sources.get(String(id)).source.id) };
  });
  log(`${sample.sample_id}: ${messages.length} messages, ${items.length} questions`);

  const rows = [];
  const builds = [];
  const [msgStats] = await Message.aggregate([{ $match: { conversationId: { $in: built.conversations.map((c) => c._id) } } }, { $group: { _id: null, bytes: { $sum: { $bsonSize: '$$ROOT' } } } }]);
  builds.push({ sample: sample.sample_id, store: 'raw messages', messages_mined: 0, memory_bytes: msgStats.bytes });

  const run = async (system, contextFor) => {
    for (const item of items) {
      const start = process.hrtime.bigint();
      const context = await contextFor(item.question);
      rows.push(await answerAndScore({ system, item, context, asOf, retrievalMs: ms(start) }));
    }
    log(`  ${system.id}: ${items.length} questions answered`);
  };

  for (const system of chosen.filter((s) => s.id === 'full_context')) {
    const context = S.fullContext(messages);
    await run(system, async () => context);
  }
  for (const system of chosen.filter((s) => s.id === 'rag_messages')) {
    const index = await S.buildMessageIndex(messages);
    // Vectors stored as BSON doubles: the storage RAG adds on top of the raw messages
    const vectorBytes = index.reduce((s, e) => s + e.vector.length * 8, 0);
    builds.push({ sample: sample.sample_id, store: 'rag message vectors', messages_mined: 0, memory_bytes: vectorBytes });
    await run(system, (q) => S.ragContext(index, q, k));
  }

  const extractionCache = new Map(); // both stores receive the SAME extracted facts
  for (const store of ['bitemporal', 'overwrite']) {
    const users = chosen.filter((s) => s.store === store);
    if (users.length === 0) continue;
    await clearStore(perspectives.map((p) => p.userId));
    const b = await buildStore(perspectives, store, extractionCache);
    builds.push({ sample: sample.sample_id, ...b });
    log(`  ${store} store: ${b.memory_versions} versions (${b.memory_current} current) in ${b.build_seconds} s; ${b.decisions}`);
    for (const system of users) await run(system, (q) => S.memoryContext(system, perspectives, sources, q, k, asOf));
  }
  return { rows, builds };
}

module.exports = { evaluateSample, pickQuestions, mirror, NO_INFO };
