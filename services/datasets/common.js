const User = require('../../models/User');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Memory = require('../../models/Memory');
const AuditLog = require('../../models/AuditLog');
const Job = require('../../models/Job');
const LlmCall = require('../../models/LlmCall');
const EvalItem = require('../../models/EvalItem');

// Removes dataset users and EVERYTHING that references them (the same collections as deleting a user through
// the API), so a reset never leaves dangling userIds. Bulk deletes without a transaction: a reset of 1M
// synthetic memories would be far too big for one transaction. It is still safe to re-run after a crash,
// because the users themselves are deleted LAST, so a half-finished reset is simply finished next time.
async function removeUsers(userIds) {
  if (!userIds.length) return { users: 0, conversations: 0, messages: 0, memories: 0, evalItems: 0 };
  const byUser = { userId: { $in: userIds } };
  const conversationIds = (await Conversation.find(byUser).select('_id').lean()).map((c) => c._id);

  const evalItems = await EvalItem.deleteMany(byUser);
  const memories = await Memory.deleteMany(byUser);
  await Promise.all([AuditLog.deleteMany(byUser), Job.deleteMany(byUser), LlmCall.deleteMany(byUser)]);
  const messages = await Message.deleteMany({ conversationId: { $in: conversationIds } });
  const conversations = await Conversation.deleteMany(byUser);
  const users = await User.deleteMany({ _id: { $in: userIds } });
  return {
    users: users.deletedCount,
    conversations: conversations.deletedCount,
    messages: messages.deletedCount,
    memories: memories.deletedCount,
    evalItems: evalItems.deletedCount,
  };
}

// A small seeded pseudo-random generator (mulberry32). Math.random cannot be seeded, and the synthetic data
// must be REPRODUCIBLE: the same seed always gives exactly the same documents.
function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next, // a float in [0, 1)
    int: (min, max) => min + Math.floor(next() * (max - min + 1)), // inclusive
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

module.exports = { removeUsers, createRng };
