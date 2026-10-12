const bcrypt = require('bcryptjs');

const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Memory = require('../models/Memory');
const AuditLog = require('../models/AuditLog');
const Job = require('../models/Job');
const LlmCall = require('../models/LlmCall');
const EvalItem = require('../models/EvalItem');
const { badRequest, forbidden, conflict, unauthorized } = require('./errors');
const { toObjectId } = require('./ids');
const { withTransaction } = require('./transaction');
const { hashPassword, validatePassword, requireString } = require('./authService');

// "Self only": the id in the URL must be the caller's own id (or the word "me")
function assertSelf(user, id) {
  if (id !== 'me' && String(toObjectId(id, 'userId')) !== String(user._id)) {
    throw forbidden('You can only access your own account');
  }
}

async function getUser(user, id) {
  assertSelf(user, id);
  return User.findById(user._id);
}

async function updateUser(user, id, body = {}) {
  assertSelf(user, id);
  const doc = await User.findById(user._id).select('+passwordHash');

  const fields = ['name', 'email', 'occupation'].filter((field) => body[field] !== undefined);
  if (fields.length === 0 && body.password === undefined) {
    throw badRequest('Provide at least one of: name, email, occupation, password');
  }
  for (const field of fields) doc[field] = body[field];
  if (body.password !== undefined) {
    // Changing the password requires proof of the current one
    requireString(body.currentPassword, 'currentPassword');
    if (!(await bcrypt.compare(body.currentPassword, doc.passwordHash))) throw unauthorized('currentPassword is incorrect');
    validatePassword(body.password);
    doc.passwordHash = await hashPassword(body.password);
  }

  try {
    await doc.save();
  } catch (err) {
    if (err.code === 11000) throw conflict('An account with this email already exists');
    throw err;
  }
  return doc;
}

// Cascade delete inside one transaction (MongoDB runs as a replica set since Stage 2): either the account
// and everything it owns is gone, or nothing is. This is a hard delete: every memory version and the
// user's audit log entries go too, because erasing a person must also erase the copies kept in the history.
async function deleteUser(user, id) {
  assertSelf(user, id);
  return withTransaction(async (session) => {
    const conversations = await Conversation.find({ userId: user._id }).select('_id').session(session).lean();
    const conversationIds = conversations.map((c) => c._id);

    const memories = await Memory.deleteMany({ userId: user._id }, { session });
    const auditEntries = await AuditLog.deleteMany({ userId: user._id }, { session });
    const jobs = await Job.deleteMany({ userId: user._id }, { session });
    const llmCalls = await LlmCall.deleteMany({ userId: user._id }, { session });
    // Stage 5: benchmark questions point at this user's messages, so they go too (no dangling references)
    const evalItems = await EvalItem.deleteMany({ userId: user._id }, { session });
    const messages = await Message.deleteMany({ conversationId: { $in: conversationIds } }, { session });
    const removedConversations = await Conversation.deleteMany({ userId: user._id }, { session });
    await User.deleteOne({ _id: user._id }, { session });

    return {
      memories: memories.deletedCount,
      messages: messages.deletedCount,
      conversations: removedConversations.deletedCount,
      auditEntries: auditEntries.deletedCount,
      jobs: jobs.deletedCount,
      llmCalls: llmCalls.deletedCount,
      evalItems: evalItems.deletedCount,
    };
  });
}

module.exports = { getUser, updateUser, deleteUser };
