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
  let failed = 0;
  for (const { p, m } of queue) {
    // A message whose LLM calls fail (after the provider's own retry) is counted and skipped, not fatal:
    // the store is built without it, and failed_messages in build.csv says how many were lost
    let result;
    try {
      result = await processMessage({ userId: p.userId, messageId: m._id, conversationId: m.conversationId }, { versioning, extractionCache });
    } catch (err) {
      failed += 1;
      continue;
    }
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
    failed_messages: failed,
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
  // One failed call (e.g. a local model's answer cut off at its token cap) must not end a run of thousands of
  // questions. The row is kept, marked with the error and scored as WRONG (F1 0, judge 0): dropping it would
  // make a system that fails often look better than it is. summary_by_system.csv counts these rows (errors).
  let error = null;
  let answered;
  try {
    answered = await callLlmDetailed({
      task: 'eval_answer',
      vars: { asOf: asOf.toISOString().slice(0, 10), contextKind: context.kind, context: contextText, question: item.question },
      extra: { question: item.question, items: context.items },
      cachePrefix: system.id === 'full_context',
    });
  } catch (err) {
    error = `answer: ${err.message}`;
    answered = { data: { answer: '', citedMemories: [], insufficient: false }, usage: {}, latencyMs: null, costUsd: null, tokensEstimated: false, provider: null, model: null };
  }
  let judged = { data: { correct: false, reason: 'not judged: the answer call failed' }, latencyMs: null, costUsd: null, model: null };
  if (!error) {
    try {
      judged = await callLlmDetailed({
        task: 'judge',
        vars: { question: item.question, gold, candidate: answered.data.answer },
        extra: { gold: item.answer, candidate: answered.data.answer },
      });
    } catch (err) {
      error = `judge: ${err.message}`;
      judged = { data: { correct: false, reason: 'not judged: the judge call failed' }, latencyMs: null, costUsd: null, model: null };
    }
  }
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
    score_f1: error && error.startsWith('answer') ? 0 : Math.round(locomoScore(answered.data.answer, item) * 1e4) / 1e4,
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
    error,
  };
}

// The four groups of systems that share one build, in the order they run. A memory store is built once per
// group, so every system of a group answers from the SAME store.
const GROUPS = ['full_context', 'rag_messages', 'bitemporal', 'overwrite'];
const groupOf = (system) => system.store || system.id;
const BUILD_OF_GROUP = { rag_messages: 'rag message vectors', bitemporal: 'bitemporal', overwrite: 'overwrite' };

// Runs every requested system on the chosen questions of one LoCoMo sample.
// Returns { rows, builds } (rows: one per system x question; builds: one per memory store + raw storage).
//
// Stage 6b: with a `ledger` (eval/checkpoint.js) every finished row and build is written down at once, and a
// sample that was interrupted continues from the ledger instead of starting again:
//   - a finished (system, question) is never asked again;
//   - a memory store that is still in MongoDB, and was recorded as fully built, is reused;
//   - a store group that is only PARTLY answered but whose store is gone is thrown away and redone, so that all
//     systems of a group always answer from one single build.
// `resetDb` (required with a ledger) empties the disposable database when the sample must start from nothing.
// Without a ledger the database must be empty and the behaviour is exactly the Stage 6 one.
async function evaluateSample(sample, { questions = 10, k = 10, systems = S.SYSTEM_IDS, seed = 1, log = () => {}, ledger = null, resetDb = null } = {}) {
  const chosen = systems.map((id) => {
    const s = S.SYSTEMS.find((x) => x.id === id);
    if (!s) throw new Error(`Unknown system "${id}" (known: ${S.SYSTEM_IDS.join(', ')})`);
    return s;
  });
  if (ledger && !resetDb) throw new Error('evaluateSample needs resetDb when it is given a ledger');
  const sid = sample.sample_id;
  const built = buildSample(sample);
  const { speaker_a: speakerA, speaker_b: speakerB } = sample.conversation;
  const mirrored = mirror(built, speakerB);
  const messages = [...built.messages].sort((a, b) => a.sentAt - b.sentAt);
  // Evidence is translated through these ids, which exist in memory only (the database may hold an earlier copy)
  const freshSources = new Map([...built.messages, ...mirrored.messages].map((m) => [String(m._id), m]));
  // The question date: the day after the last session (LoCoMo questions are asked after the conversation)
  const asOf = new Date(messages[messages.length - 1].sentAt.getTime() + 86400000);
  // Evidence as dialog ids, keeping only the ids that match a loaded turn (Stage 5 lists the others apart)
  const items = pickQuestions(sample.qa, questions, seed).map((i) => {
    const item = built.evalItems[i];
    return { ...item, index: i, sampleId: sid, evidence: item.evidenceMessageIds.map((id) => freshSources.get(String(id)).source.id) };
  });

  const rowMap = ledger ? ledger.rowsFor(sid) : new Map();
  const buildMap = new Map();
  const getBuild = (store) => (ledger ? ledger.buildOf(sid, store) : buildMap.get(store)) || null;
  const putBuild = (build) => {
    if (ledger) ledger.addBuild(sid, build);
    else buildMap.set(build.store, build);
  };
  const keyOf = (system, item) => `${system.id}|${item.index}`;
  const answeredIn = (group) => chosen.filter((s) => groupOf(s) === group).reduce((n, s) => n + items.filter((item) => rowMap.has(keyOf(s, item))).length, 0);
  const groupDone = (group) => {
    const members = chosen.filter((s) => groupOf(s) === group);
    if (members.length === 0) return true;
    if (BUILD_OF_GROUP[group] && !getBuild(BUILD_OF_GROUP[group])) return false;
    return answeredIn(group) === members.length * items.length;
  };
  const record = (row) => {
    if (ledger) ledger.addRow(row);
    else rowMap.set(`${row.system}|${row.qa_index}`, row);
  };

  // The database: reuse this sample's users when they are still there, else start from an empty database
  const needDb = !ledger || !groupDone('bitemporal') || !groupDone('overwrite') || !getBuild('raw messages');
  let perspectives = null;
  let sources = freshSources;
  if (needDb) {
    const prior = ledger ? ledger.dataOf(sid) : null;
    const attached = prior ? await reattach(prior, built, mirrored, { speakerA, speakerB }) : null;
    if (attached) {
      perspectives = attached.perspectives;
      sources = attached.sources;
      await ensureCategories();
      log(`${sid}: continuing with the sample already in MongoDB`);
    } else {
      // resetDb drops the categories too, so they are created after it
      if (ledger) await resetDb();
      await ensureCategories();
      for (const part of [built, mirrored]) {
        await User.create(part.user);
        await Conversation.insertMany(part.conversations);
        await Message.insertMany(part.messages);
      }
      perspectives = [
        { userId: built.user._id, person: speakerA, messages: built.messages },
        { userId: mirrored.user._id, person: speakerB, messages: mirrored.messages },
      ];
      if (ledger) ledger.setData(sid, perspectives.map((p) => String(p.userId)));
    }
    if (!getBuild('raw messages')) {
      const [msgStats] = await Message.aggregate([{ $match: { conversationId: { $in: [...new Set(perspectives[0].messages.map((m) => String(m.conversationId)))].map((id) => new mongoose.Types.ObjectId(id)) } } }, { $group: { _id: null, bytes: { $sum: { $bsonSize: '$$ROOT' } } } }]);
      putBuild({ sample: sid, store: 'raw messages', messages_mined: 0, memory_bytes: msgStats.bytes });
    }
  }
  const reused = rowMap.size;
  log(`${sid}: ${messages.length} messages, ${items.length} questions${reused ? `, ${reused} answers already in the checkpoint` : ''}`);

  const run = async (system, contextFor) => {
    let asked = 0;
    for (const item of items) {
      if (rowMap.has(keyOf(system, item))) continue;
      const start = process.hrtime.bigint();
      const context = await contextFor(item.question);
      record(await answerAndScore({ system, item, context, asOf, retrievalMs: ms(start) }));
      asked += 1;
    }
    log(`  ${system.id}: ${items.length} questions answered${asked < items.length ? ` (${items.length - asked} from the checkpoint)` : ''}`);
  };

  for (const system of chosen.filter((s) => groupOf(s) === 'full_context')) {
    const context = S.fullContext(messages);
    await run(system, async () => context);
  }
  if (!groupDone('rag_messages')) {
    for (const system of chosen.filter((s) => groupOf(s) === 'rag_messages')) {
      const index = await S.buildMessageIndex(messages);
      if (!getBuild('rag message vectors')) {
        // Vectors stored as BSON doubles: the storage RAG adds on top of the raw messages
        const vectorBytes = index.reduce((n, e) => n + e.vector.length * 8, 0);
        putBuild({ sample: sid, store: 'rag message vectors', messages_mined: 0, memory_bytes: vectorBytes });
      }
      await run(system, (q) => S.ragContext(index, q, k));
    }
  } else if (chosen.some((s) => groupOf(s) === 'rag_messages')) log('  rag_messages: all answers from the checkpoint');

  let extractionCache = ledger ? ledger.cacheFor(sid) : new Map(); // both stores receive the SAME extracted facts
  const userIds = perspectives ? perspectives.map((p) => p.userId) : [];
  for (const store of ['bitemporal', 'overwrite']) {
    const users = chosen.filter((s) => s.store === store);
    if (users.length === 0) continue;
    if (groupDone(store)) {
      log(`  ${store} store: all answers from the checkpoint`);
      continue;
    }
    // Reuse the store only if the ledger says it was fully built AND MongoDB still holds exactly that many versions
    const last = ledger ? ledger.lastStore(sid) : null;
    const reusable = !!(last && last.store === store && last.built && (await Memory.countDocuments({ userId: { $in: userIds } })) === last.versions && getBuild(store));
    if (!reusable) {
      if (ledger && (answeredIn(store) > 0 || getBuild(store))) {
        // A store that is gone cannot answer the rest of its group; the rows of the old build are redone, so the
        // whole group answers from one build
        ledger.discard(sid, { systems: users.map((s) => s.id), builds: [store] });
        log(`  ${store}: the earlier store is not in MongoDB any more, so this group is answered again from a new build`);
      }
      // A bitemporal store starts a new extraction cache; the overwrite store must keep the bitemporal one
      if (ledger && store === 'bitemporal') {
        ledger.resetCache(sid);
        extractionCache = ledger.cacheFor(sid);
      }
      await clearStore(userIds);
      if (ledger) ledger.storeStart(sid, store);
      const b = await buildStore(perspectives, store, extractionCache);
      putBuild({ sample: sid, ...b });
      if (ledger) ledger.storeBuilt(sid, store, b.memory_versions);
      log(`  ${store} store: ${b.memory_versions} versions (${b.memory_current} current) in ${b.build_seconds} s; ${b.decisions}`);
    } else log(`  ${store} store: reusing the store built before the interruption`);
    for (const system of users) await run(system, (q) => S.memoryContext(system, perspectives, sources, q, k, asOf));
  }

  // The rows and builds in the order an uninterrupted run produces them
  const rows = [];
  for (const group of GROUPS) {
    for (const system of chosen.filter((s) => groupOf(s) === group)) for (const item of items) rows.push(rowMap.get(keyOf(system, item)));
  }
  const builds = ['raw messages', 'rag message vectors', 'bitemporal', 'overwrite'].map(getBuild).filter(Boolean);
  if (ledger) ledger.markDone(sid);
  return { rows, builds };
}

// Finds the sample's users, conversations and messages from an earlier process in MongoDB. Returns the
// perspectives and the message lookup, or null when the database does not hold exactly that sample (then the
// caller starts from an empty database).
async function reattach(prior, built, mirrored, { speakerA, speakerB }) {
  const ids = prior.userIds.map((id) => new mongoose.Types.ObjectId(id));
  if (ids.length !== 2 || (await User.countDocuments({ _id: { $in: ids } })) !== 2) return null;
  const conversations = await Conversation.find({ userId: { $in: ids } }).select('_id userId').lean();
  if (conversations.length !== built.conversations.length + mirrored.conversations.length) return null;
  const stored = await Message.find({ conversationId: { $in: conversations.map((c) => c._id) } }).lean();
  if (stored.length !== built.messages.length + mirrored.messages.length) return null;
  const owner = new Map(conversations.map((c) => [String(c._id), String(c.userId)]));
  const perspectives = [speakerA, speakerB].map((person, i) => ({
    userId: ids[i],
    person,
    messages: stored.filter((m) => owner.get(String(m.conversationId)) === String(ids[i])),
  }));
  return { perspectives, sources: new Map(stored.map((m) => [String(m._id), m])) };
}

module.exports = { evaluateSample, pickQuestions, mirror, NO_INFO };
