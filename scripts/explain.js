/**
 * Prints the indexes of every collection and the query plan (explain "executionStats") of the main
 * queries, so you can see whether each one uses an index (IXSCAN, or EXPRESS_IXSCAN on MongoDB 8 for simple
 * equality lookups) or reads the whole collection (COLLSCAN).
 * Run on a seeded database with:  npm run explain
 *
 * Exits with an error if a collection has duplicate indexes or a query falls back to COLLSCAN.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User');
const Category = require('../models/Category');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Memory = require('../models/Memory');
const AuditLog = require('../models/AuditLog');
const Job = require('../models/Job');
const LlmCall = require('../models/LlmCall');
const EvalItem = require('../models/EvalItem');
const { CURRENT, temporalFilter } = require('../services/memoryService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';

// Every stage of a plan, from the outermost to the innermost, with index names where used
function planStages(plan, out = []) {
  if (!plan) return out;
  out.push(plan.indexName ? `${plan.stage}(${plan.indexName})` : plan.stage);
  planStages(plan.inputStage, out);
  (plan.inputStages || []).forEach((p) => planStages(p, out));
  planStages(plan.queryPlan, out);
  return out;
}

function findStage(plan, stageName) {
  if (!plan) return false;
  if (plan.stage === stageName) return true;
  return (
    findStage(plan.inputStage, stageName) ||
    (plan.inputStages || []).some((p) => findStage(p, stageName)) ||
    findStage(plan.queryPlan, stageName)
  );
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}\n`);
  let problems = 0;

  // 1) Index list per collection (the same index must never appear twice)
  console.log('INDEXES');
  // The Stage 3 collections stay empty until a message is posted, so make sure they (and their indexes) exist
  await Promise.all([Job.init(), LlmCall.init()]);
  for (const Model of [User, Category, Conversation, Message, Memory, AuditLog, Job, LlmCall, EvalItem]) {
    const indexes = await Model.collection.indexes();
    const names = indexes.map((i) => i.name);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    console.log(`  ${Model.collection.name}: ${names.join(', ')}`);
    if (duplicates.length > 0) {
      problems++;
      console.log(`    !! duplicate indexes: ${duplicates.join(', ')}`);
    }
  }

  // 2) Query plans, for a real user and one of their conversations. Dataset users (Stage 5) are skipped:
  // synthetic users have no conversations and LoCoMo users have no memories until extraction runs.
  const user = await User.findOne({ dataset: null }).sort({ _id: 1 }).lean();
  if (!user) {
    console.log('\nNo data found. Run "npm run seed" first.');
    return mongoose.disconnect();
  }
  const conversation = await Conversation.findOne({ userId: user._id }).lean();
  const memory = await Memory.findOne({ userId: user._id }).lean();
  // A memory with a version chain, if the seed made one for this user
  const versioned = (await Memory.findOne({ userId: user._id, supersedes: { $ne: null } }).lean()) || memory;
  const at = versioned.validFrom.toISOString();
  console.log(`\nQUERY PLANS (for ${user.email}; time-travel queries at ${at})`);

  const queries = [
    // Current state: validTo = null and retractedAt = null are equality matches, served by the current-state indexes
    ['memories: current, newest first', () => Memory.find({ userId: user._id, ...CURRENT }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    ['memories: current, by status', () => Memory.find({ userId: user._id, ...CURRENT, status: 'Active' }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    ['memories: current, by category', () => Memory.find({ userId: user._id, ...CURRENT, categoryId: memory.categoryId }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    // Time travel: valid time (asOf), transaction time (knownAt) and both, served by { userId, _id, validFrom, recordedAt }
    ['memories: ?asOf= (valid time)', () => Memory.find({ userId: user._id, ...temporalFilter({ asOf: at }).filter }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    ['memories: ?knownAt= (transaction time)', () => Memory.find({ userId: user._id, ...temporalFilter({ knownAt: at }).filter }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    ['memories: ?asOf=&knownAt= (both)', () => Memory.find({ userId: user._id, ...temporalFilter({ asOf: at, knownAt: new Date().toISOString() }).filter }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    // Each $graphLookup hop of the history endpoint is a lookup by _id
    ['memories: history hop (version by _id)', () => Memory.find({ _id: versioned._id, userId: user._id }).explain('executionStats')],
    ['memories: text search (current)', () => Memory.find({ userId: user._id, ...CURRENT, $text: { $search: 'learn' } }).explain('executionStats')],
    ['memories: category in use? (delete check)', () => Memory.find({ categoryId: memory.categoryId, retractedAt: null }).limit(1).explain('executionStats')],
    ['aggregation: $match current (by-category / status-ratio)', () => Memory.aggregate([{ $match: { userId: user._id, ...CURRENT } }, { $group: { _id: '$categoryId', count: { $sum: 1 } } }]).explain('executionStats')],
    ['auditlog: my entries, newest first', () => AuditLog.find({ userId: user._id }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    ['conversations: list newest first', () => Conversation.find({ userId: user._id }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    ['messages: one conversation in order', () => Message.find({ conversationId: conversation._id }).sort({ sentAt: 1, _id: 1 }).limit(21).explain('executionStats')],
    // Stage 3: the worker's claim query, the extractor's recent-window read, and the per-user logs
    ['jobs: claim the oldest due job', () => Job.find({ status: 'pending', runAt: { $lte: new Date() } }).sort({ runAt: 1 }).limit(1).explain('executionStats')],
    ['jobs: my jobs, newest first', () => Job.find({ userId: user._id }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    ['messages: recent window before a message', () => Message.find({ conversationId: conversation._id, sentAt: { $lt: new Date() } }).sort({ sentAt: -1, _id: -1 }).limit(6).explain('executionStats')],
    ['llmcalls: my calls, newest first', () => LlmCall.find({ userId: user._id }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    ['users: login by email', () => User.find({ email: user.email }).explain('executionStats')],
  ];

  for (const [label, run] of queries) {
    const explain = await run();
    // An aggregation reports its plan under stages[0].$cursor; a find reports it at the top level
    const root = explain.stages ? explain.stages[0].$cursor : explain;
    const stats = root.executionStats;
    const stages = planStages(root.queryPlanner.winningPlan);
    const collscan = findStage(root.queryPlanner.winningPlan, 'COLLSCAN');
    if (collscan) problems++;
    console.log(`\n  ${label}`);
    console.log(`    plan:     ${stages.join(' -> ')}`);
    console.log(`    returned: ${stats.nReturned}, keys examined: ${stats.totalKeysExamined}, docs examined: ${stats.totalDocsExamined}, ${stats.executionTimeMillis} ms`);
    if (collscan) console.log('    !! COLLSCAN: this query reads the whole collection');
    if (findStage(root.queryPlanner.winningPlan, 'SORT')) console.log('    note: in-memory SORT stage (the index does not provide the order)');
  }

  console.log(problems === 0 ? '\nOK: no duplicate indexes and no collection scans.' : `\n${problems} problem(s) found.`);
  process.exitCode = problems === 0 ? 0 : 1;
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Explain failed:', err.message);
  process.exitCode = 1;
  mongoose.disconnect();
});
