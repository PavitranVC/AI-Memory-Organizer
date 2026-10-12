const mongoose = require('mongoose');
const User = require('../../models/User');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const EvalItem = require('../../models/EvalItem');
const { withTransaction } = require('../transaction');
const { removeUsers } = require('./common');

// LoCoMo (Maharana et al., ACL 2024): 10 very long two-person chats, each split into dated sessions, with
// question-answer labels. Mapping into our schema (see docs/DATASETS.md):
//   one LoCoMo sample  -> one User        (dataset 'benchmark', source { name: 'locomo', id: sample_id })
//   one session        -> one Conversation (source.session = its number, source.date = its timestamp)
//   one dialog turn    -> one Message      (source.id = dia_id such as 'D1:3', source.speaker = the name)
//   one qa entry       -> one EvalItem     (a separate collection, so the app never sees the gold answers)
const SOURCE = 'locomo';
const DATASET = 'benchmark';

// LoCoMo stores the category as a number only. The names below follow the paper's five question types; the
// number-to-name order is our reading, checked against the data by scripts/datasets/locomo-stats.js
// (results/stage5-locomo-stats.txt). TODO: verify against the authors' evaluation code.
const QUESTION_TYPES = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' };

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// "1:56 pm on 8 May, 2023" -> Date. LoCoMo gives no time zone, so the time is read as UTC.
function parseLocomoDate(text) {
  const match = /^(\d{1,2}):(\d{2}) (am|pm) on (\d{1,2}) ([A-Za-z]+),? (\d{4})$/i.exec(String(text).trim());
  const month = match ? MONTHS.indexOf(match[5].toLowerCase()) : -1;
  if (!match || month < 0) throw new Error(`Unrecognised LoCoMo date: "${text}"`);
  const hour = (Number(match[1]) % 12) + (match[3].toLowerCase() === 'pm' ? 12 : 0);
  return new Date(Date.UTC(Number(match[6]), month, Number(match[4]), hour, Number(match[2])));
}

// The evidence lists contain a few malformed entries ("D8:6; D9:17", "D:11:26", "D30:05"). Split and normalise
// them to the "D<session>:<turn>" form used by dia_id; anything else is returned as invalid, never guessed.
function normaliseEvidence(evidence = []) {
  const ids = [];
  const invalid = [];
  for (const entry of evidence) {
    for (const token of String(entry).split(/[;,\s]+/).filter(Boolean)) {
      const match = /^D:?(\d+):0*(\d+)$/.exec(token);
      if (match) ids.push(`D${Number(match[1])}:${Number(match[2])}`);
      else invalid.push(token);
    }
  }
  return { ids: [...new Set(ids)], invalid };
}

// The sessions of a sample, in chronological (numeric) order. A date key without turns is ignored.
function sessionsOf(conversation) {
  return Object.keys(conversation)
    .map((key) => /^session_(\d+)$/.exec(key))
    .filter(Boolean)
    .map((match) => ({ number: Number(match[1]), turns: conversation[match[0]] || [], dateText: conversation[`${match[0]}_date_time`] }))
    .filter((s) => s.turns.length > 0)
    .sort((a, b) => a.number - b.number);
}

// An image turn keeps its text and gains the caption LoCoMo provides (the images themselves are not released)
function turnContent(turn) {
  const text = String(turn.text || '').trim();
  return turn.blip_caption ? `${text} [shared an image: ${String(turn.blip_caption).trim()}]`.trim() : text;
}

const asText = (value) => (value === undefined || value === null ? null : String(value));

// Builds every document of one sample in memory (ids included), so it can be inserted in one transaction
function buildSample(sample, { passwordHash } = {}) {
  const { sample_id: sampleId, conversation } = sample || {};
  if (!sampleId || !conversation || !conversation.speaker_a || !conversation.speaker_b || !Array.isArray(sample.qa)) {
    throw new Error(`Not a LoCoMo sample (needs sample_id, conversation.speaker_a/b and qa): ${String(sampleId)}`);
  }
  const { speaker_a: speakerA, speaker_b: speakerB } = conversation;
  const userId = new mongoose.Types.ObjectId();
  const user = {
    _id: userId,
    name: `${speakerA} & ${speakerB} (LoCoMo ${sampleId})`,
    email: `locomo-${sampleId}@benchmark.invalid`.toLowerCase(),
    dataset: DATASET,
    source: { name: SOURCE, id: sampleId },
    ...(passwordHash ? { passwordHash } : {}),
  };

  const conversations = [];
  const messages = [];
  const messageIdByDia = new Map();
  for (const session of sessionsOf(conversation)) {
    const date = parseLocomoDate(session.dateText);
    const conversationId = new mongoose.Types.ObjectId();
    conversations.push({
      _id: conversationId,
      userId,
      title: `LoCoMo ${sampleId}, session ${session.number}`,
      dataset: DATASET,
      source: { name: SOURCE, id: sampleId, session: session.number, date },
    });
    session.turns.forEach((turn, i) => {
      // LoCoMo is a chat between two people, not a person and an assistant: speaker_a is stored as the
      // 'user' and speaker_b as the 'assistant', and the real names stay in source.speaker.
      const role = turn.speaker === speakerA ? 'user' : 'assistant';
      const _id = new mongoose.Types.ObjectId();
      messageIdByDia.set(turn.dia_id, _id);
      messages.push({
        _id,
        conversationId,
        role,
        content: turnContent(turn),
        // Turns only have the session's timestamp; one second per turn keeps them in their original order
        sentAt: new Date(date.getTime() + i * 1000),
        dataset: DATASET,
        source: { name: SOURCE, id: turn.dia_id, speaker: turn.speaker },
      });
    });
  }

  const evalItems = sample.qa.map((qa, index) => {
    const { ids, invalid } = normaliseEvidence(qa.evidence);
    const found = ids.filter((id) => messageIdByDia.has(id));
    return {
      dataset: DATASET,
      source: { name: SOURCE, id: sampleId, index },
      userId,
      question: qa.question,
      answer: asText(qa.answer),
      adversarialAnswer: asText(qa.adversarial_answer),
      category: qa.category,
      questionType: QUESTION_TYPES[qa.category] || 'unknown',
      evidence: (qa.evidence || []).map(String),
      evidenceMessageIds: found.map((id) => messageIdByDia.get(id)),
      unresolvedEvidence: [...invalid, ...ids.filter((id) => !messageIdByDia.has(id))],
    };
  });

  return { user, conversations, messages, evalItems };
}

// Loads LoCoMo samples. Idempotent: a sample that is already loaded is skipped, or replaced with reset: true.
// Each sample is written in ONE transaction, so a crash never leaves a half-loaded sample behind.
// Loading does not queue extraction jobs (it does not go through the API): Stage 6 decides when to extract.
async function loadLocomo(samples, { reset = false, passwordHash = null, onSample = () => {} } = {}) {
  if (!Array.isArray(samples)) throw new Error('LoCoMo data must be a JSON array of samples');
  const summary = { samples: samples.length, loaded: 0, skipped: 0, replaced: 0, users: 0, conversations: 0, messages: 0, evalItems: 0, unresolvedEvidence: 0 };

  for (const sample of samples) {
    const built = buildSample(sample, { passwordHash });
    const existing = await User.findOne({ 'source.name': SOURCE, 'source.id': built.user.source.id }).select('_id').lean();
    if (existing && !reset) {
      summary.skipped += 1;
      onSample({ sampleId: built.user.source.id, status: 'skipped' });
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
      await EvalItem.insertMany(built.evalItems, { session });
    });

    const unresolved = built.evalItems.reduce((n, item) => n + item.unresolvedEvidence.length, 0);
    summary.loaded += 1;
    summary.users += 1;
    summary.conversations += built.conversations.length;
    summary.messages += built.messages.length;
    summary.evalItems += built.evalItems.length;
    summary.unresolvedEvidence += unresolved;
    onSample({ sampleId: built.user.source.id, status: existing ? 'replaced' : 'loaded', conversations: built.conversations.length, messages: built.messages.length, evalItems: built.evalItems.length, unresolvedEvidence: unresolved });
  }
  return summary;
}

module.exports = { loadLocomo, buildSample, parseLocomoDate, normaliseEvidence, QUESTION_TYPES, SOURCE };
