/**
 * Runs the representative queries of the project report on a seeded database and writes what they return to
 * results/stage9-report-queries.txt, with the command, commit, date and dataset first (CLAUDE.md: every number
 * in a document comes from a committed script run). It only reads.
 *   npm run seed && npm run report:queries
 * The queries are written as data (collection, operation, filter or pipeline) so the file shows exactly what ran.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const mongoose = require('mongoose');

const User = require('../models/User');
const Category = require('../models/Category');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Memory = require('../models/Memory');
const AuditLog = require('../models/AuditLog');
const { CURRENT, temporalFilter } = require('../services/memoryService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';
const OUT = path.join(__dirname, '..', 'results', 'stage9-report-queries.txt');
const MODELS = { users: User, categories: Category, conversations: Conversation, messages: Message, memories: Memory, auditlog: AuditLog };
const SHOW_ROWS = 5;

async function main() {
  await mongoose.connect(MONGO_URI);
  const users = await User.find({ dataset: null }).sort({ _id: 1 }).lean();
  const byEmail = (start) => users.find((u) => u.email.startsWith(start));
  const aarav = byEmail('aarav');
  const priya = byEmail('priya');
  if (!aarav || !priya) throw new Error('The seeded users were not found. Run "npm run seed" first.');
  const categories = await Category.find().lean();
  const personal = categories.find((c) => c.name === 'Personal');
  const health = categories.find((c) => c.name === 'Health');

  // ObjectIds are printed as names, so the output reads the same on every seeded database
  const names = new Map([[String(aarav._id), '<Aarav _id>'], [String(priya._id), '<Priya _id>'], [String(personal._id), '<Personal _id>'], [String(health._id), '<Health _id>']]);
  const show = (value) => JSON.stringify(value, (key, v) => (typeof v === 'string' && names.has(v) ? names.get(v) : v));

  const asOf = (when) => temporalFilter({ asOf: when }).filter;
  const both = (when, known) => temporalFilter({ asOf: when, knownAt: known }).filter;
  const plain = { _id: 0, content: 1, importance: 1, status: 1 };
  const currentOf = (user) => ({ userId: user._id, ...CURRENT });

  const queries = [
    // ---------------------------------------------------------------- Selection
    { id: 'S1', kind: 'Selection', title: "Priya's current memories, newest first", on: 'memories', find: currentOf(priya), project: plain, sort: { _id: -1 }, limit: 3 },
    { id: 'S2', kind: 'Selection', title: "Aarav's Active memories of importance 4 or more, most important first", on: 'memories', find: { ...currentOf(aarav), status: 'Active', importance: { $gte: 4 } }, project: plain, sort: { importance: -1, _id: -1 }, limit: SHOW_ROWS },
    { id: 'S3', kind: 'Selection (valid time)', title: "Priya's Personal memories as of 2023-06-01", on: 'memories', find: { userId: priya._id, categoryId: personal._id, ...asOf('2023-06-01') }, project: { _id: 0, content: 1, validFrom: 1, validTo: 1 } },
    { id: 'S4', kind: 'Selection (valid time)', title: "Priya's Personal memories as of 2024-08-10", on: 'memories', find: { userId: priya._id, categoryId: personal._id, ...asOf('2024-08-10') }, project: { _id: 0, content: 1, validFrom: 1, validTo: 1 } },
    { id: 'S5', kind: 'Selection (both axes)', title: "The same date, as the database knew it on 2024-08-15 (the move had not been recorded yet)", on: 'memories', find: { userId: priya._id, categoryId: personal._id, ...both('2024-08-10', '2024-08-15') }, project: { _id: 0, content: 1, validFrom: 1, validTo: 1, recordedAt: 1 } },
    { id: 'S6', kind: 'Selection (text index)', title: "Aarav's current memories that match the keyword \"react\", best match first", on: 'memories', find: { ...currentOf(aarav), $text: { $search: 'react' } }, project: { _id: 0, content: 1, score: { $meta: 'textScore' } }, sort: { score: { $meta: 'textScore' } }, limit: SHOW_ROWS },

    // ---------------------------------------------------------------- Joins ($lookup)
    {
      id: 'J1', kind: 'Join and aggregation', title: "Priya's current memories per category, with the category name", on: 'memories',
      aggregate: [
        { $match: currentOf(priya) },
        { $group: { _id: '$categoryId', memories: { $sum: 1 }, avgImportance: { $avg: '$importance' } } },
        { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'category' } },
        { $unwind: '$category' },
        { $project: { _id: 0, category: '$category.name', memories: 1, avgImportance: { $round: ['$avgImportance', 2] } } },
        { $sort: { memories: -1, category: 1 } },
      ],
    },
    {
      id: 'J2', kind: 'Join (two lookups)', title: "Aarav's three newest memories with the owner's name and the category name", on: 'memories',
      aggregate: [
        { $match: currentOf(aarav) },
        { $sort: { _id: -1 } },
        { $limit: 3 },
        { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'owner' } },
        { $lookup: { from: 'categories', localField: 'categoryId', foreignField: '_id', as: 'category' } },
        { $project: { _id: 0, owner: { $first: '$owner.name' }, category: { $first: '$category.name' }, content: 1 } },
      ],
    },
    {
      id: 'J3', kind: 'Join', title: 'Current memories with the title of the conversation they came from (three shown)', on: 'memories',
      aggregate: [
        { $match: { ...CURRENT, userId: priya._id } },
        { $lookup: { from: 'conversations', localField: 'conversationId', foreignField: '_id', as: 'conversation' } },
        { $project: { _id: 0, conversation: { $first: '$conversation.title' }, content: 1 } },
        { $limit: 3 },
      ],
    },

    // ---------------------------------------------------------------- Grouping and aggregation
    {
      id: 'G1', kind: 'Grouping', title: "Aarav's Active versus Archived memories (the status-ratio report)", on: 'memories',
      aggregate: [
        { $match: currentOf(aarav) },
        { $group: { _id: null, total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } }, archived: { $sum: { $cond: [{ $eq: ['$status', 'Archived'] }, 1, 0] } } } },
        { $project: { _id: 0, total: 1, active: 1, archived: 1, activePercent: { $round: [{ $multiply: [{ $divide: ['$active', '$total'] }, 100] }, 1] } } },
      ],
    },
    {
      id: 'G2', kind: 'Grouping (two keys)', title: 'Number of current memories and average importance for each user and category', on: 'memories',
      aggregate: [
        { $match: CURRENT },
        { $group: { _id: { userId: '$userId', categoryId: '$categoryId' }, memories: { $sum: 1 }, avgImportance: { $avg: '$importance' } } },
        { $lookup: { from: 'users', localField: '_id.userId', foreignField: '_id', as: 'u' } },
        { $lookup: { from: 'categories', localField: '_id.categoryId', foreignField: '_id', as: 'c' } },
        { $project: { _id: 0, user: { $first: '$u.name' }, category: { $first: '$c.name' }, memories: 1, avgImportance: { $round: ['$avgImportance', 2] } } },
        { $sort: { user: 1, category: 1 } },
      ],
      rows: 12,
    },
    {
      id: 'G3', kind: 'Grouping across collections', title: 'Messages per conversation, with the first and last message time', on: 'messages',
      aggregate: [
        { $group: { _id: '$conversationId', messages: { $sum: 1 }, first: { $min: '$sentAt' }, last: { $max: '$sentAt' } } },
        { $lookup: { from: 'conversations', localField: '_id', foreignField: '_id', as: 'c' } },
        { $project: { _id: 0, conversation: { $first: '$c.title' }, messages: 1 } },
        { $sort: { messages: -1, conversation: 1 } },
      ],
    },

    // ---------------------------------------------------------------- Subqueries
    {
      id: 'U1', kind: 'Correlated subquery', title: 'For each category, how many current memories are more important than the average of that category', on: 'memories',
      aggregate: [
        { $match: CURRENT },
        { $group: { _id: '$categoryId', avgImportance: { $avg: '$importance' } } },
        { $lookup: { from: 'memories', let: { category: '$_id', avg: '$avgImportance' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$categoryId', '$$category'] }, { $eq: ['$validTo', null] }, { $eq: ['$retractedAt', null] }, { $gt: ['$importance', '$$avg'] }] } } }, { $count: 'n' }], as: 'above' } },
        { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'c' } },
        { $project: { _id: 0, category: { $first: '$c.name' }, avgImportance: { $round: ['$avgImportance', 2] }, above: { $ifNull: [{ $first: '$above.n' }, 0] } } },
        { $sort: { category: 1 } },
      ],
    },
    {
      id: 'U2', kind: 'Subquery on an aggregate', title: 'Conversations that produced more current memories than the average conversation', on: 'memories',
      aggregate: [
        { $match: CURRENT },
        { $group: { _id: '$conversationId', n: { $sum: 1 } } },
        { $setWindowFields: { output: { avgN: { $avg: '$n', window: { documents: ['unbounded', 'unbounded'] } } } } },
        { $match: { $expr: { $gt: ['$n', '$avgN'] } } },
        { $lookup: { from: 'conversations', localField: '_id', foreignField: '_id', as: 'c' } },
        { $project: { _id: 0, conversation: { $first: '$c.title' }, memories: '$n', average: { $round: ['$avgN', 2] } } },
        { $sort: { memories: -1, conversation: 1 } },
      ],
    },

    // ---------------------------------------------------------------- Set operations
    {
      id: 'X1', kind: 'Set operations', title: "Tags of Aarav and Priya: how many in the union, in both, and only Aarav's", on: 'memories',
      aggregate: [
        { $match: { ...CURRENT, userId: { $in: [aarav._id, priya._id] } } },
        { $unwind: '$tags' },
        { $group: { _id: '$userId', tags: { $addToSet: '$tags' } } },
        { $group: { _id: null, sets: { $push: { user: '$_id', tags: '$tags' } } } },
        { $project: { _id: 0, a: { $first: { $map: { input: { $filter: { input: '$sets', cond: { $eq: ['$$this.user', aarav._id] } } }, in: '$$this.tags' } } }, p: { $first: { $map: { input: { $filter: { input: '$sets', cond: { $eq: ['$$this.user', priya._id] } } }, in: '$$this.tags' } } } } },
        { $project: { aaravTags: { $size: '$a' }, priyaTags: { $size: '$p' }, union: { $size: { $setUnion: ['$a', '$p'] } }, inBoth: { $size: { $setIntersection: ['$a', '$p'] } }, onlyAarav: { $size: { $setDifference: ['$a', '$p'] } } } },
      ],
    },
    {
      id: 'X2', kind: 'Set operation ($unionWith)', title: "Contents of Aarav's Health memories followed by Priya's Health memories (two result sets joined, three shown)", on: 'memories',
      aggregate: [
        { $match: { ...currentOf(aarav), categoryId: health._id } },
        { $project: { _id: 0, owner: { $literal: 'Aarav' }, content: 1 } },
        { $unionWith: { coll: 'memories', pipeline: [{ $match: { ...currentOf(priya), categoryId: health._id } }, { $project: { _id: 0, owner: { $literal: 'Priya' }, content: 1 } }] } },
        { $limit: 3 },
      ],
    },

    // ---------------------------------------------------------------- Recursive and audit
    {
      id: 'R1', kind: 'Recursive lookup ($graphLookup)', title: "The version chain behind Priya's current Personal memory about where she lives", on: 'memories',
      aggregate: [
        { $match: { userId: priya._id, categoryId: personal._id, ...CURRENT, supersedes: { $ne: null } } },
        { $limit: 1 },
        { $graphLookup: { from: 'memories', startWith: '$supersedes', connectFromField: 'supersedes', connectToField: '_id', as: 'earlier', maxDepth: 10 } },
        { $project: { _id: 0, current: '$content', earlierVersions: { $map: { input: '$earlier', as: 'v', in: { content: '$$v.content', validTo: '$$v.validTo' } } } } },
      ],
    },
    {
      id: 'A1', kind: 'Grouping', title: 'Audit log entries by action', on: 'auditlog',
      aggregate: [{ $group: { _id: '$action', entries: { $sum: 1 } } }, { $project: { _id: 0, action: '$_id', entries: 1 } }, { $sort: { entries: -1, action: 1 } }],
    },
  ];

  const lines = [];
  const say = (text = '') => lines.push(text);
  const commit = execSync('git rev-parse --short HEAD').toString().trim();
  say('Report queries on the seeded sample database (application data, no dataset label)');
  say('command: npm run seed && npm run report:queries');
  say(`commit: ${commit}`);
  say(`date: ${new Date().toISOString()}`);
  say(`database: ${mongoose.connection.name}; MongoDB ${(await mongoose.connection.db.admin().serverInfo()).version}`);
  say(`documents: users ${await User.countDocuments()}, categories ${await Category.countDocuments()}, conversations ${await Conversation.countDocuments()}, messages ${await Message.countDocuments()}, memories ${await Memory.countDocuments()} (${await Memory.countDocuments(CURRENT)} current), auditlog ${await AuditLog.countDocuments()}`);

  for (const q of queries) {
    const Model = MODELS[q.on];
    say();
    say(`[${q.id}] ${q.kind}: ${q.title}`);
    let rows;
    if (q.find) {
      say(`  db.${q.on}.find(${show(q.find)}, ${show(q.project)})${q.sort ? `.sort(${show(q.sort)})` : ''}${q.limit ? `.limit(${q.limit})` : ''}`);
      const total = await Model.countDocuments(q.find);
      let cursor = Model.find(q.find, q.project);
      if (q.sort) cursor = cursor.sort(q.sort);
      if (q.limit) cursor = cursor.limit(q.limit);
      rows = await cursor.lean();
      say(`  matching documents: ${total}; shown: ${rows.length}`);
    } else {
      say(`  db.${q.on}.aggregate(${show(q.aggregate)})`);
      rows = await Model.aggregate(q.aggregate);
      say(`  result rows: ${rows.length}`);
    }
    for (const row of rows.slice(0, q.rows || SHOW_ROWS)) say(`    ${show(row)}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
  console.log(`Ran ${queries.length} queries. Wrote ${path.relative(process.cwd(), OUT)}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});
