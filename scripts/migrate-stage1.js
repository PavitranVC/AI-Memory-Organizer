/**
 * One-off migration of a database created before Stage 1 (the DBMS-review version).
 * Safe to run more than once. Run with:  npm run migrate
 *
 *  1. Drops the indexes Stage 1 replaces (old standalone userId / status indexes, the old compound and
 *     text indexes, the old conversation index), then builds the new ones from the Mongoose schemas.
 *  2. Moves messages embedded in conversation documents into the messages collection.
 *  3. Optionally gives users without a password one (MIGRATE_DEFAULT_PASSWORD), so they can log in.
 *     Without it, those users cannot log in until they get a password; they are listed in the output.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User');
const Category = require('../models/Category');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Memory = require('../models/Memory');
const { hashPassword } = require('../services/authService');

// Indexes created by the pre-Stage-1 schemas that no longer exist in the Stage 1 schemas
const OLD_INDEXES = {
  memories: ['userId_1', 'status_1', 'userId_1_status_1_importance_-1', 'content_text_tags_text'],
  conversations: ['userId_1_createdAt_-1'],
  categories: ['name_1'], // replaced by a case-insensitive unique index
};

async function dropOldIndexes(db) {
  const dropped = [];
  for (const [collection, names] of Object.entries(OLD_INDEXES)) {
    const existing = await db.listCollections({ name: collection }).toArray();
    if (existing.length === 0) continue;
    const present = new Set((await db.collection(collection).indexes()).map((i) => i.name));
    for (const name of names) {
      if (!present.has(name)) continue;
      await db.collection(collection).dropIndex(name);
      dropped.push(`${collection}.${name}`);
    }
  }
  return dropped;
}

async function moveEmbeddedMessages(db) {
  const conversations = db.collection('conversations');
  const messages = db.collection('messages');
  let moved = 0;
  const cursor = conversations.find({ messages: { $exists: true } });
  for await (const conversation of cursor) {
    const embedded = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (embedded.length > 0) {
      await messages.insertMany(
        embedded.map((m, n) => ({
          conversationId: conversation._id,
          role: m.role,
          content: m.content,
          sentAt: m.sentAt || new Date(conversation.createdAt.getTime() + n * 1000),
        }))
      );
      moved += embedded.length;
    }
    // Only unset once the messages are safely inserted, so a crash cannot lose them
    await conversations.updateOne({ _id: conversation._id }, { $unset: { messages: '' } });
  }
  return moved;
}

async function migrate({ defaultPassword } = {}) {
  const db = mongoose.connection.db;
  const result = { droppedIndexes: await dropOldIndexes(db) };
  result.movedMessages = await moveEmbeddedMessages(db);

  // Build the Stage 1 indexes
  await Promise.all([User, Category, Conversation, Message, Memory].map((Model) => Model.createIndexes()));

  const withoutPassword = await User.find({ passwordHash: { $exists: false } }).select('email').lean();
  if (defaultPassword && withoutPassword.length > 0) {
    const passwordHash = await hashPassword(defaultPassword);
    await User.updateMany({ _id: { $in: withoutPassword.map((u) => u._id) } }, { $set: { passwordHash } });
    result.passwordsSet = withoutPassword.length;
  } else {
    result.usersWithoutPassword = withoutPassword.map((u) => u.email);
  }
  return result;
}

module.exports = { migrate };

if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';
  mongoose
    .connect(MONGO_URI)
    .then(() => migrate({ defaultPassword: process.env.MIGRATE_DEFAULT_PASSWORD }))
    .then((result) => console.log('Migration complete:', JSON.stringify(result, null, 2)))
    .catch((err) => {
      console.error('Migration failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
