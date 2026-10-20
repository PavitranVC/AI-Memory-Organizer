const mongoose = require('mongoose');
const User = require('../../models/User');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const EvalItem = require('../../models/EvalItem');
const { withTransaction } = require('../transaction');
const { removeUsers, createRng } = require('./common');

// LongMemEval (believed to be Wu et al., 2024; TODO: verify the citation): about 500 hand-written questions, each asked about its OWN chat history between
// a user and an assistant. Mapping into our schema (see docs/DATASETS.md):
//   one question           -> one User         (dataset 'benchmark', source { name: 'longmemeval', id: question_id })
//   one haystack session   -> one Conversation (source.id = its session id, source.session = chronological number)
//   one turn               -> one Message      (source.id = '<session id>:<turn index>', source.speaker = role)
//   the question + answer  -> one EvalItem     (a separate collection, so the app never sees the gold answers)
// Every question gets its own user because the benchmark gives every question its own history; the same session
// can appear in many questions' histories and is simply stored once per question.
const SOURCE = 'longmemeval';
const DATASET = 'benchmark';

// LongMemEval has no numeric categories, so the numbers below are OURS (EvalItem.category is required and the
// harness groups by it). The six names are the benchmark's own `question_type` strings, kept in questionType.
const QUESTION_TYPES = {
  'single-session-user': 1,
  'single-session-assistant': 2,
  'single-session-preference': 3,
  'multi-session': 4,
  'knowledge-update': 5,
  'temporal-reasoning': 6,
};

// Message.content is capped at 10,000 characters. A longer turn is cut and marked, and the loader counts them,
// so no turn is lost without a trace. (None of the 10,960 turns of the oracle file is that long.)
const MAX_CONTENT = 10000;
const TRUNCATED_MARK = ' [truncated]';

// "2023/04/10 (Mon) 17:50" -> Date. LongMemEval gives no time zone, so the time is read as UTC. The weekday in
// brackets is redundant and is not checked.
function parseLongMemEvalDate(text) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/.exec(String(text).trim());
  if (!match) throw new Error(`Unrecognised LongMemEval date: "${text}"`);
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  // Date.UTC rolls 2023/02/31 over to March; a rolled-over date means the text was not a real date
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59) {
    throw new Error(`Unrecognised LongMemEval date: "${text}"`);
  }
  return date;
}

const isAbstention = (questionId) => /_abs$/.test(String(questionId));
const clip = (text) => (text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT - TRUNCATED_MARK.length)}${TRUNCATED_MARK}` : text);

// Builds every document of one question in memory (ids included), so it can be inserted in one transaction
function buildQuestion(item, { passwordHash } = {}) {
  const { question_id: questionId } = item || {};
  const ok = questionId && item.question && item.answer !== undefined && item.answer !== null && item.question_date &&
    Array.isArray(item.haystack_sessions) && Array.isArray(item.haystack_dates) && Array.isArray(item.haystack_session_ids);
  if (!ok) {
    throw new Error(`Not a LongMemEval question (needs question_id, question, answer, question_date and haystack_sessions/dates/session_ids): ${String(questionId)}`);
  }
  if (item.haystack_sessions.length !== item.haystack_dates.length || item.haystack_sessions.length !== item.haystack_session_ids.length) {
    throw new Error(`LongMemEval question ${questionId}: haystack_sessions, haystack_dates and haystack_session_ids differ in length`);
  }
  const type = QUESTION_TYPES[item.question_type] ? item.question_type : null;
  if (!type) throw new Error(`LongMemEval question ${questionId}: unknown question_type "${item.question_type}"`);

  const userId = new mongoose.Types.ObjectId();
  const user = {
    _id: userId,
    name: `LongMemEval ${questionId}`,
    email: `longmemeval-${questionId}@benchmark.invalid`.toLowerCase(),
    dataset: DATASET,
    source: { name: SOURCE, id: questionId },
    ...(passwordHash ? { passwordHash } : {}),
  };

  // The file does not list the sessions in time order (34 of the 500 oracle questions are out of order), but
  // memory is built by reading a history from oldest to newest. Sort by date; equal dates keep the file order.
  const sessions = item.haystack_sessions
    .map((turns, index) => ({ turns, index, id: String(item.haystack_session_ids[index]), date: parseLongMemEvalDate(item.haystack_dates[index]) }))
    .sort((a, b) => a.date - b.date || a.index - b.index);

  const conversations = [];
  const messages = [];
  const evidenceMessageIds = [];
  const evidence = [];
  let truncatedTurns = 0;
  sessions.forEach((session, order) => {
    const conversationId = new mongoose.Types.ObjectId();
    conversations.push({
      _id: conversationId,
      userId,
      title: `LongMemEval ${questionId}, session ${order + 1}`,
      dataset: DATASET,
      source: { name: SOURCE, id: session.id, session: order + 1, date: session.date },
    });
    session.turns.forEach((turn, i) => {
      const text = String(turn.content === undefined || turn.content === null ? '' : turn.content).trim();
      if (!text) return; // Message.content is required; the oracle file has no empty turn
      if (text.length > MAX_CONTENT) truncatedTurns += 1;
      const _id = new mongoose.Types.ObjectId();
      const id = `${session.id}:${i}`;
      messages.push({
        _id,
        conversationId,
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        content: clip(text),
        // Turns only have the session's timestamp; one second per turn keeps them in their original order
        sentAt: new Date(session.date.getTime() + i * 1000),
        dataset: DATASET,
        source: { name: SOURCE, id, speaker: turn.role },
      });
      if (turn.has_answer === true) {
        evidence.push(id);
        evidenceMessageIds.push(_id);
      }
    });
  });

  const evalItem = {
    dataset: DATASET,
    source: { name: SOURCE, id: questionId, index: 0 },
    userId,
    question: item.question,
    answer: String(item.answer), // a few answers are numbers
    adversarialAnswer: null,
    category: QUESTION_TYPES[type],
    questionType: type,
    questionDate: parseLongMemEvalDate(item.question_date),
    abstention: isAbstention(questionId),
    evidence,
    evidenceMessageIds,
    unresolvedEvidence: [],
  };

  return { user, conversations, messages, evalItem, truncatedTurns };
}

// Picks a subset for a pilot. types: only these question types. perType: at most N questions of each type,
// chosen with a seeded shuffle (same seed, same questions), then put back in file order. ids: only these question
// ids. Without options every question is kept. Unknown types or ids are an error, never silently ignored.
function selectQuestions(items, { types, perType, ids, seed = 1 } = {}) {
  if (!Array.isArray(items)) throw new Error('LongMemEval data must be a JSON array of questions');
  let chosen = items.map((item, index) => ({ item, index }));
  if (ids && ids.length) {
    const unknown = ids.filter((id) => !items.some((x) => x.question_id === id));
    if (unknown.length) throw new Error(`Unknown LongMemEval question id(s): ${unknown.join(', ')}`);
    chosen = chosen.filter(({ item }) => ids.includes(item.question_id));
  }
  if (types && types.length) {
    const unknown = types.filter((t) => !QUESTION_TYPES[t]);
    if (unknown.length) throw new Error(`Unknown LongMemEval question type(s): ${unknown.join(', ')} (known: ${Object.keys(QUESTION_TYPES).join(', ')})`);
    chosen = chosen.filter(({ item }) => types.includes(item.question_type));
  }
  if (perType) {
    const rng = createRng(seed);
    const kept = [];
    for (const type of Object.keys(QUESTION_TYPES)) {
      const ofType = chosen.filter(({ item }) => item.question_type === type);
      for (let i = ofType.length - 1; i > 0; i -= 1) {
        const j = rng.int(0, i);
        [ofType[i], ofType[j]] = [ofType[j], ofType[i]];
      }
      kept.push(...ofType.slice(0, perType));
    }
    chosen = kept.sort((a, b) => a.index - b.index);
  }
  return chosen.map(({ item }) => item);
}

// Loads LongMemEval questions. Idempotent: a question that is already loaded is skipped, or replaced with
// reset: true. Each question is written in ONE transaction, so a crash never leaves a half-loaded history behind.
// Loading does not queue extraction jobs (it does not go through the API): Stage 6 decides when to extract.
async function loadLongMemEval(items, { reset = false, passwordHash = null, onQuestion = () => {} } = {}) {
  if (!Array.isArray(items)) throw new Error('LongMemEval data must be a JSON array of questions');
  const summary = { questions: items.length, loaded: 0, skipped: 0, replaced: 0, users: 0, conversations: 0, messages: 0, evalItems: 0, truncatedTurns: 0 };

  for (const item of items) {
    const built = buildQuestion(item, { passwordHash });
    const existing = await User.findOne({ 'source.name': SOURCE, 'source.id': built.user.source.id }).select('_id').lean();
    if (existing && !reset) {
      summary.skipped += 1;
      onQuestion({ questionId: built.user.source.id, status: 'skipped' });
      continue;
    }
    if (existing) {
      await removeUsers([existing._id]);
      summary.replaced += 1;
    }

    await withTransaction(async (session) => {
      await User.create([built.user], { session });
      await Conversation.insertMany(built.conversations, { session });
      await Message.insertMany(built.messages, { session });
      await EvalItem.create([built.evalItem], { session });
    });

    summary.loaded += 1;
    summary.users += 1;
    summary.conversations += built.conversations.length;
    summary.messages += built.messages.length;
    summary.evalItems += 1;
    summary.truncatedTurns += built.truncatedTurns;
    onQuestion({
      questionId: built.user.source.id,
      status: existing ? 'replaced' : 'loaded',
      questionType: built.evalItem.questionType,
      conversations: built.conversations.length,
      messages: built.messages.length,
      evidence: built.evalItem.evidence.length,
    });
  }
  return summary;
}

module.exports = { loadLongMemEval, buildQuestion, selectQuestions, parseLongMemEvalDate, isAbstention, QUESTION_TYPES, SOURCE };
