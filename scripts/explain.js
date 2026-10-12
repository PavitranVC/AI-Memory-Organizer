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
  for (const Model of [User, Category, Conversation, Message, Memory]) {
    const indexes = await Model.collection.indexes();
    const names = indexes.map((i) => i.name);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    console.log(`  ${Model.collection.name}: ${names.join(', ')}`);
    if (duplicates.length > 0) {
      problems++;
      console.log(`    !! duplicate indexes: ${duplicates.join(', ')}`);
    }
  }

  // 2) Query plans, for a real user and one of their conversations
  const user = await User.findOne().sort({ _id: 1 }).lean();
  if (!user) {
    console.log('\nNo data found. Run "npm run seed" first.');
    return mongoose.disconnect();
  }
  const conversation = await Conversation.findOne({ userId: user._id }).lean();
  const memory = await Memory.findOne({ userId: user._id }).lean();
  console.log(`\nQUERY PLANS (for ${user.email})`);

  const queries = [
    ['memories: list newest first', () => Memory.find({ userId: user._id }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    ['memories: by status', () => Memory.find({ userId: user._id, status: 'Active' }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    ['memories: by category', () => Memory.find({ userId: user._id, categoryId: memory.categoryId }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    ['memories: text search', () => Memory.find({ userId: user._id, $text: { $search: 'learn' } }).explain('executionStats')],
    ['memories: category in use? (delete check)', () => Memory.find({ categoryId: memory.categoryId }).limit(1).explain('executionStats')],
    ['aggregation: $match userId (by-category / status-ratio)', () => Memory.aggregate([{ $match: { userId: user._id } }, { $group: { _id: '$categoryId', count: { $sum: 1 } } }]).explain('executionStats')],
    ['conversations: list newest first', () => Conversation.find({ userId: user._id }).sort({ _id: -1 }).limit(21).explain('executionStats')],
    ['messages: one conversation in order', () => Message.find({ conversationId: conversation._id }).sort({ sentAt: 1, _id: 1 }).limit(21).explain('executionStats')],
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
