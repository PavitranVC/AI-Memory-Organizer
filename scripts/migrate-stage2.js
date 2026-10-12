/**
 * Migration of a Stage 1 database to the Stage 2 bi-temporal schema. Safe to run more than once.
 * Run with:  npm run migrate   (runs the Stage 1 migration first, then this one)
 *
 *  1. Drops the Stage 1 memory indexes that Stage 2 replaces, then builds the Stage 2 indexes.
 *  2. Turns every memory without a recordedAt into a current, first version:
 *       validFrom = recordedAt = createdAt (or the time inside its ObjectId if createdAt is missing),
 *       validTo = retractedAt = closedAt = supersedes = supersededBy = null, confidence 1, no sources,
 *       sensitivity "special" for Health memories and "normal" otherwise, no accesses yet.
 *  3. Writes one "migrate" entry per converted memory to the audit log, in the same transaction as the
 *     conversion, so every memory has a log entry and a second run finds nothing left to convert.
 * Needs MongoDB running as a replica set (transactions).
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Memory = require('../models/Memory');
const Category = require('../models/Category');
const AuditLog = require('../models/AuditLog');

// Stage 1 memory indexes that are replaced by the Stage 2 ones (see models/Memory.js)
const OLD_INDEXES = ['userId_1__id_-1', 'userId_1_status_1__id_-1', 'userId_1_categoryId_1__id_-1', 'categoryId_1'];
const SPECIAL_CATEGORIES = ['health'];
const BATCH_SIZE = 500;

async function dropOldIndexes(db) {
  const exists = await db.listCollections({ name: 'memories' }).toArray();
  if (exists.length === 0) return [];
  const present = new Set((await db.collection('memories').indexes()).map((i) => i.name));
  const dropped = [];
  for (const name of OLD_INDEXES) {
    if (!present.has(name)) continue;
    await db.collection('memories').dropIndex(name);
    dropped.push(`memories.${name}`);
  }
  return dropped;
}

async function migrate() {
  const db = mongoose.connection.db;
  const memories = db.collection('memories');
  const result = { droppedIndexes: await dropOldIndexes(db), convertedMemories: 0 };

  const special = await Category.find().select('name').lean();
  const specialIds = special.filter((c) => SPECIAL_CATEGORIES.includes(c.name.toLowerCase())).map((c) => c._id);

  // Every field is filled with $ifNull, so a value that is already there is never overwritten
  const firstVersion = [
    {
      $set: {
        validFrom: { $ifNull: ['$validFrom', '$createdAt', { $toDate: '$_id' }] },
        recordedAt: { $ifNull: ['$recordedAt', '$createdAt', { $toDate: '$_id' }] },
        validTo: { $ifNull: ['$validTo', null] },
        retractedAt: { $ifNull: ['$retractedAt', null] },
        closedAt: { $ifNull: ['$closedAt', null] },
        supersedes: { $ifNull: ['$supersedes', null] },
        supersededBy: { $ifNull: ['$supersededBy', null] },
        sourceMessageIds: { $ifNull: ['$sourceMessageIds', []] },
        confidence: { $ifNull: ['$confidence', 1] },
        sensitivity: { $ifNull: ['$sensitivity', { $cond: [{ $in: ['$categoryId', specialIds] }, 'special', 'normal'] }] },
        lastAccessedAt: { $ifNull: ['$lastAccessedAt', null] },
        accessCount: { $ifNull: ['$accessCount', 0] },
      },
    },
  ];

  // Batches, each converted and logged in one transaction. A crash between batches loses nothing:
  // the next run picks up the memories that still have no recordedAt.
  for (;;) {
    const ids = (await memories.find({ recordedAt: { $exists: false } }).project({ _id: 1 }).limit(BATCH_SIZE).toArray()).map((m) => m._id);
    if (ids.length === 0) break;
    await mongoose.connection.transaction(async (session) => {
      await memories.updateMany({ _id: { $in: ids }, recordedAt: { $exists: false } }, firstVersion, { session });
      const converted = await memories.find({ _id: { $in: ids } }, { session }).toArray();
      await AuditLog.insertMany(
        converted.map((m) => ({ userId: m.userId, memoryId: m._id, action: 'migrate', actorId: null, at: new Date(), before: null, after: m })),
        { session }
      );
    });
    result.convertedMemories += ids.length;
  }

  // Build the Stage 2 indexes (and the audit log's)
  await Promise.all([Memory.createIndexes(), AuditLog.createIndexes()]);
  return result;
}

module.exports = { migrate };

if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';
  mongoose
    .connect(MONGO_URI)
    .then(() => migrate())
    .then((result) => console.log('Stage 2 migration complete:', JSON.stringify(result, null, 2)))
    .catch((err) => {
      console.error('Stage 2 migration failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
