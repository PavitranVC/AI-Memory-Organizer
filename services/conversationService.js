const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Memory = require('../models/Memory');
const { badRequest, notFound } = require('./errors');
const { toObjectId } = require('./ids');
const { paginate, parseLimit, parseCursor } = require('./pagination');
const { requireString } = require('./authService');

// Loads a conversation only if it belongs to the user. Someone else's conversation is reported as
// "not found", so ids of other users' data cannot be probed.
async function getOwnedConversation(userId, id) {
  const conversation = await Conversation.findOne({ _id: toObjectId(id, 'conversationId'), userId });
  if (!conversation) throw notFound('Conversation not found');
  return conversation;
}

async function listConversations(userId, query) {
  const { items, limit, nextCursor } = await paginate(Conversation, { userId }, query);
  return { count: items.length, limit, nextCursor, conversations: items };
}

async function getConversation(userId, id) {
  const conversation = await getOwnedConversation(userId, id);
  const messageCount = await Message.countDocuments({ conversationId: conversation._id });
  return { ...conversation.toObject(), messageCount };
}

async function createConversation(userId, { title } = {}) {
  return Conversation.create({ userId, title: requireString(title, 'title') });
}

async function updateConversation(userId, id, { title } = {}) {
  const conversation = await getOwnedConversation(userId, id);
  conversation.title = requireString(title, 'title');
  return conversation.save();
}

// Deletes the conversation and its messages. Memories extracted from it belong to the user and
// are kept, but lose the link to the conversation (erasing them by lineage is Stage 7).
// Not transactional (a plain mongod has no transactions): the conversation is removed last, so a
// failure half-way leaves it in place and the request can simply be repeated.
async function deleteConversation(userId, id) {
  const conversation = await getOwnedConversation(userId, id);
  const messages = await Message.deleteMany({ conversationId: conversation._id });
  const memories = await Memory.updateMany({ userId, conversationId: conversation._id }, { $unset: { conversationId: 1 } });
  await conversation.deleteOne();
  return { conversation, deletedMessages: messages.deletedCount, unlinkedMemories: memories.modifiedCount };
}

// Messages are read in chat order (sentAt, then _id for ties). The cursor is the _id of the last message
// of the previous page, so a page starts strictly after that message.
async function listMessages(userId, conversationId, query) {
  const conversation = await getOwnedConversation(userId, conversationId);
  const limit = parseLimit(query.limit);
  const cursorId = parseCursor(query.cursor);

  const filter = { conversationId: conversation._id };
  if (cursorId) {
    const last = await Message.findOne({ _id: cursorId, conversationId: conversation._id }).select('sentAt').lean();
    if (!last) throw badRequest('cursor does not belong to this conversation');
    filter.$or = [{ sentAt: { $gt: last.sentAt } }, { sentAt: last.sentAt, _id: { $gt: cursorId } }];
  }

  const rows = await Message.find(filter)
    .sort({ sentAt: 1, _id: 1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(0, limit) : rows;
  return { count: messages.length, limit, nextCursor: hasMore ? messages[messages.length - 1]._id : null, messages };
}

async function createMessage(userId, conversationId, { role, content } = {}) {
  const conversation = await getOwnedConversation(userId, conversationId);
  return Message.create({ conversationId: conversation._id, role, content });
}

module.exports = {
  getOwnedConversation,
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  listMessages,
  createMessage,
};
