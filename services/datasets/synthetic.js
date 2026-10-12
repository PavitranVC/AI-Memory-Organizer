const mongoose = require('mongoose');
const User = require('../../models/User');
const Category = require('../../models/Category');
const Memory = require('../../models/Memory');
const { removeUsers, createRng } = require('./common');

// Synthetic scale data for the index experiments (10k / 100k / 1M memories). Every document is labelled
// dataset: 'synthetic' and is used ONLY for performance numbers, never for accuracy (CLAUDE.md).
// The shape imitates the real schema: chains of versions (supersede), some retracted versions, a mix of
// categories, statuses and sensitivities, so the temporal indexes are exercised the way real data would.
const SOURCE = 'synthetic-scale';
const DATASET = 'synthetic';
const DEFAULT_CATEGORIES = ['Learning', 'Personal', 'Health', 'Hobbies'];

const SUBJECTS = ['I', 'My sister', 'My manager', 'My partner', 'My friend Sam', 'My doctor', 'My landlord', 'My team'];
const VERBS = ['likes', 'is learning', 'wants to try', 'stopped', 'is allergic to', 'recommends', 'is planning', 'dislikes', 'works on', 'is reading about'];
const OBJECTS = ['rock climbing', 'Spanish', 'MongoDB indexing', 'spicy food', 'the guitar', 'marathon training', 'a trip to Goa', 'oat milk',
  'machine learning', 'watercolour painting', 'night shifts', 'a vegetarian diet', 'chess openings', 'the new apartment', 'yoga', 'Kotlin'];
const QUALIFIERS = ['on weekends', 'since last year', 'every morning', 'for work', 'with friends', 'after the exam', 'this month', 'again'];
const TAGS = ['food', 'work', 'travel', 'health', 'sport', 'music', 'family', 'study', 'money', 'home'];

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2023, 0, 1); // generated valid times fall between 2023 and the end of 2025
const SPAN = 3 * 365 * DAY;

// A deterministic ObjectId: 4 bytes of time (so _id order follows recordedAt, as with real inserts) and
// 8 bytes from the seeded generator. Same seed => same ids, so a run can be reproduced exactly.
function makeId(rng, time) {
  const seconds = Math.floor(time / 1000).toString(16).padStart(8, '0');
  let rest = '';
  for (let i = 0; i < 4; i += 1) rest += rng.int(0, 0xffff).toString(16).padStart(4, '0');
  return new mongoose.Types.ObjectId(seconds + rest);
}

// The shared categories the generator files memories under (created if the database has none of them)
async function ensureCategories() {
  for (const name of DEFAULT_CATEGORIES) {
    await Category.updateOne({ name }, { $setOnInsert: { name } }, { upsert: true, collation: { locale: 'en', strength: 2 } });
  }
  return Category.find({ name: { $in: DEFAULT_CATEGORIES } }).collation({ locale: 'en', strength: 2 }).select('name').lean();
}

// One fact as a chain of 1-3 versions. Later versions supersede earlier ones (validTo = next validFrom), and a
// small share of chains is deleted (the current version retracted), as happens through the API.
function factChain(rng, userId, categories, maxVersions) {
  const category = rng.pick(categories);
  const roll = rng.next();
  const length = Math.min(maxVersions, roll < 0.8 ? 1 : roll < 0.95 ? 2 : 3);
  const sensitivity = category.name === 'Health' ? 'special' : rng.chance(0.15) ? 'personal' : 'normal';
  const subject = rng.pick(SUBJECTS);
  const tags = [...new Set(Array.from({ length: rng.int(0, 3) }, () => rng.pick(TAGS)))];

  const versions = [];
  let validFrom = START + Math.floor(rng.next() * SPAN * 0.9);
  for (let v = 0; v < length; v += 1) {
    const recordedAt = validFrom + rng.int(0, 2 * DAY); // learned about the fact shortly after it began
    versions.push({
      _id: makeId(rng, recordedAt),
      userId,
      categoryId: category._id,
      content: `${subject} ${rng.pick(VERBS)} ${rng.pick(OBJECTS)} ${rng.pick(QUALIFIERS)}.`,
      importance: rng.int(1, 5),
      status: rng.chance(0.9) ? 'Active' : 'Archived',
      tags,
      dataset: DATASET,
      validFrom: new Date(validFrom),
      validTo: null,
      recordedAt: new Date(recordedAt),
      retractedAt: null,
      closedAt: null,
      sourceMessageIds: [],
      confidence: Math.round((0.5 + rng.next() * 0.5) * 100) / 100,
      sensitivity,
      supersedes: null,
      supersededBy: null,
      lastAccessedAt: rng.chance(0.3) ? new Date(recordedAt + rng.int(1, 60) * DAY) : null,
      accessCount: rng.int(0, 20),
      createdAt: new Date(recordedAt),
      updatedAt: new Date(recordedAt),
    });
    validFrom += rng.int(7, 120) * DAY;
  }
  // Link the chain exactly as memoryService.updateMemory does for a SUPERSEDE
  for (let v = 0; v + 1 < versions.length; v += 1) {
    const [old, next] = [versions[v], versions[v + 1]];
    old.validTo = next.validFrom;
    old.closedAt = next.recordedAt;
    old.supersededBy = next._id;
    old.updatedAt = next.recordedAt;
    next.supersedes = old._id;
  }
  if (rng.chance(0.03)) {
    const last = versions[versions.length - 1];
    last.retractedAt = new Date(last.recordedAt.getTime() + rng.int(1, 30) * DAY);
    last.updatedAt = last.retractedAt;
  }
  return versions;
}

// Generates exactly `memories` memory versions spread over `users` synthetic users.
// Inserts go straight to the driver in batches (no Mongoose validation per document) because 1M documents
// one by one would take far too long; the test suite checks that generated documents pass the Memory schema.
async function generateSynthetic({ memories, users, seed = 42, batchSize = 5000, reset = false, onProgress = () => {} } = {}) {
  if (!Number.isInteger(memories) || memories < 1) throw new Error('memories must be a positive whole number');
  const userCount = users === undefined ? Math.max(1, Math.ceil(memories / 1000)) : users;
  if (!Number.isInteger(userCount) || userCount < 1 || userCount > memories) throw new Error('users must be a whole number between 1 and memories');

  const existing = await User.find({ 'source.name': SOURCE }).select('_id').lean();
  let removed = null;
  if (existing.length && !reset) {
    throw new Error(`${existing.length} synthetic users already exist. Run again with --reset to replace them.`);
  }
  if (existing.length) removed = await removeUsers(existing.map((u) => u._id));

  await Promise.all([User.init(), Memory.init()]);
  const categories = await ensureCategories();
  const rng = createRng(seed);

  const userDocs = Array.from({ length: userCount }, (_, i) => ({
    _id: makeId(rng, START),
    name: `Synthetic user ${i + 1}`,
    email: `synthetic-${i + 1}@synthetic.invalid`,
    role: 'user',
    dataset: DATASET,
    source: { name: SOURCE, id: `seed-${seed}/user-${i + 1}` },
    createdAt: new Date(START),
    updatedAt: new Date(START),
  }));
  await User.collection.insertMany(userDocs, { ordered: false });

  // Memories are shared out evenly; the first users get one extra when it does not divide exactly
  const started = Date.now();
  let inserted = 0;
  let batch = [];
  const counts = { versions: 0, current: 0, superseded: 0, retracted: 0 };
  for (let u = 0; u < userCount; u += 1) {
    const quota = Math.floor(memories / userCount) + (u < memories % userCount ? 1 : 0);
    let made = 0;
    while (made < quota) {
      const chain = factChain(rng, userDocs[u]._id, categories, quota - made);
      for (const doc of chain) {
        if (doc.supersededBy) counts.superseded += 1;
        else if (doc.retractedAt) counts.retracted += 1;
        else counts.current += 1;
      }
      made += chain.length;
      batch.push(...chain);
      if (batch.length >= batchSize) {
        await Memory.collection.insertMany(batch, { ordered: false });
        inserted += batch.length;
        batch = [];
        onProgress({ inserted, total: memories });
      }
    }
  }
  if (batch.length) {
    await Memory.collection.insertMany(batch, { ordered: false });
    inserted += batch.length;
    onProgress({ inserted, total: memories });
  }
  counts.versions = inserted;

  return { seed, users: userCount, memories: inserted, ...counts, categories: categories.length, removed, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

// Removes every synthetic user and all their data
async function removeSynthetic() {
  const existing = await User.find({ 'source.name': SOURCE }).select('_id').lean();
  return removeUsers(existing.map((u) => u._id));
}

module.exports = { generateSynthetic, removeSynthetic, factChain, ensureCategories, SOURCE, DEFAULT_CATEGORIES };
