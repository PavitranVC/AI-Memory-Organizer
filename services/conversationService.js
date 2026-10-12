const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Memory = require('../models/Memory');
const Job = require('../models/Job');
const { badRequest, notFound } = require('./errors');
const { toObjectId } = require('./ids');
const { paginate, parseLimit, parseCursor } = require('./pagination');
const { requireString } = require('./authService');
const { withTransaction } = require('./transaction');
const jobService = require('./jobService');

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

// Deletes the conversation and its messages, in one transaction. Memories extracted from it belong to the
// user and are kept (every version), but lose the link to the conversation and to the deleted source
// messages, so no reference points at a missing document. Erasing them by lineage is Stage 7.
async function deleteConversation(userId, id) {
  const conversation = await getOwnedConversation(userId, id);
  return withTransaction(async (session) => {
    const messageIds = (await Message.find({ conversationId: conversation._id }).select('_id').session(session).lean()).map((m) => m._id);
    const messages = await Message.deleteMany({ conversationId: conversation._id }, { session });
    const memories = await Memory.updateMany({ userId, conversationId: conversation._id }, { $unset: { conversationId: 1 } }, { session });
    if (messageIds.length > 0) {
      await Memory.updateMany({ userId, sourceMessageIds: { $in: messageIds } }, { $pull: { sourceMessageIds: { $in: messageIds } } }, { session });
    }
    // Extraction jobs of this conversation have nothing left to read
    await Job.deleteMany({ userId, 'payload.conversationId': conversation._id }, { session });
    await Conversation.deleteOne({ _id: conversation._id }, { session });
    return { conversation, deletedMessages: messages.deletedCount, unlinkedMemories: memories.modifiedCount };
  });
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

// Saves the message and, for a user message, queues an extraction job in the SAME transaction (the
// transactional outbox pattern): the job exists if and only if the message does. The request returns
// as soon as both are saved; the LLM runs later in the worker, so the API never waits for it.
async function createMessage(userId, conversationId, { role, content } = {}) {
  const conversation = await getOwnedConversation(userId, conversationId);
  return withTransaction(async (session) => {
    const [message] = await Message.create([{ conversationId: conversation._id, role, content }], { session });
    let job = null;
    if (message.role === 'user' && jobService.extractionEnabled()) {
      job = await jobService.enqueueExtraction({ userId, messageId: message._id, conversationId: conversation._id }, session);
    }
    return { ...message.toObject(), extractionJobId: job ? job._id : null };
  });
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
