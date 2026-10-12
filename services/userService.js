const bcrypt = require('bcryptjs');

const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Memory = require('../models/Memory');
const { badRequest, forbidden, conflict, unauthorized } = require('./errors');
const { toObjectId } = require('./ids');
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

// Cascade delete, children first and the user last: if it fails half-way the user still exists,
// so the request can be repeated (a plain mongod has no multi-document transactions).
async function deleteUser(user, id) {
  assertSelf(user, id);
  const conversations = await Conversation.find({ userId: user._id }).select('_id').lean();
  const conversationIds = conversations.map((c) => c._id);

  const memories = await Memory.deleteMany({ userId: user._id });
  const messages = await Message.deleteMany({ conversationId: { $in: conversationIds } });
  const removedConversations = await Conversation.deleteMany({ userId: user._id });
  await User.deleteOne({ _id: user._id });

  return {
    memories: memories.deletedCount,
    messages: messages.deletedCount,
    conversations: removedConversations.deletedCount,
  };
}

module.exports = { getUser, updateUser, deleteUser };
