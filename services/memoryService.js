const Memory = require('../models/Memory');
const Conversation = require('../models/Conversation');
const { badRequest, notFound } = require('./errors');
const { toObjectId } = require('./ids');
const { paginate, parseLimit } = require('./pagination');
const { resolveCategoryId } = require('./categoryService');

const STATUSES = ['Active', 'Archived'];
const POPULATE = [{ path: 'categoryId', select: 'name' }];

// "archived" -> "Archived", so filters are case-insensitive. Anything else is a 400, not an empty result.
function parseStatus(value) {
  const text = String(value).trim();
  const status = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
  if (!STATUSES.includes(status)) throw badRequest(`status must be one of: ${STATUSES.join(', ')}`);
  return status;
}

function parseMinImportance(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 5) throw badRequest('minImportance must be a whole number from 1 to 5');
  return n;
}

// MongoDB has no foreign keys. A memory may only point at a conversation that exists AND is the caller's own.
async function assertOwnConversation(userId, conversationId) {
  const id = toObjectId(conversationId, 'conversationId');
  if (!(await Conversation.exists({ _id: id, userId }))) throw badRequest(`Unknown conversationId: ${id}`);
  return id;
}

// Every function takes the authenticated user's id first and puts it in the query filter, so a user can
// never read or change another user's memories, whatever ids the request contains.

async function createMemory(userId, body = {}) {
  const { conversationId, content, importance, status, tags } = body;
  const categoryId = await resolveCategoryId(body);
  const memory = await Memory.create({
    userId,
    conversationId: conversationId ? await assertOwnConversation(userId, conversationId) : undefined,
    categoryId,
    content,
    importance,
    status,
    tags,
  });
  await memory.populate(POPULATE);
  return memory;
}

async function listMemories(userId, query) {
  const filter = { userId };
  if (query.status !== undefined) filter.status = parseStatus(query.status);
  if (query.category !== undefined || query.categoryId !== undefined) {
    filter.categoryId = await resolveCategoryId({ category: query.category, categoryId: query.categoryId });
  }
  if (query.minImportance !== undefined) filter.importance = { $gte: parseMinImportance(query.minImportance) };

  const { items, limit, nextCursor } = await paginate(Memory, filter, query, { populate: POPULATE });
  return { count: items.length, limit, nextCursor, memories: items };
}

async function getMemory(userId, id) {
  const memory = await Memory.findOne({ _id: toObjectId(id), userId }).populate([
    ...POPULATE,
    { path: 'conversationId', select: 'title' },
  ]);
  if (!memory) throw notFound('Memory not found');
  return memory;
}

async function updateMemory(userId, id, body = {}) {
  const updates = {};
  for (const field of ['content', 'importance', 'status', 'tags']) {
    if (body[field] !== undefined) updates[field] = body[field];
  }
  const categoryId = await resolveCategoryId(body);
  if (categoryId) updates.categoryId = categoryId;
  if (body.conversationId !== undefined) {
    // null detaches the memory from its conversation
    updates.conversationId = body.conversationId === null ? null : await assertOwnConversation(userId, body.conversationId);
  }
  if (Object.keys(updates).length === 0) {
    throw badRequest('Provide at least one of: content, category, importance, status, tags, conversationId');
  }

  const memory = await Memory.findOneAndUpdate({ _id: toObjectId(id), userId }, updates, {
    new: true, // return the updated document
    runValidators: true, // enforce enum / min / max rules on updates too
  }).populate(POPULATE);
  if (!memory) throw notFound('Memory not found');
  return memory;
}

async function deleteMemory(userId, id) {
  const memory = await Memory.findOneAndDelete({ _id: toObjectId(id), userId });
  if (!memory) throw notFound('Memory not found');
  return memory;
}

// ---------------------------------------------------------------------------
// Aggregations (advanced NoSQL feature)
// ---------------------------------------------------------------------------

// Counts per category with $group, then $lookup joins in the category name.
// The $lookup keeps memories whose category document is missing (preserveNullAndEmptyArrays) and
// labels them, so the counts always add up to the total instead of silently dropping rows.
async function statsByCategory(userId) {
  return Memory.aggregate([
    { $match: { userId } },
    {
      $group: {
        _id: '$categoryId',
        count: { $sum: 1 },
        activeCount: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } },
        avgImportance: { $avg: '$importance' },
      },
    },
    { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'category' } },
    { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        categoryId: '$_id',
        category: { $ifNull: ['$category.name', '(unknown category)'] },
        count: 1,
        activeCount: 1,
        avgImportance: { $round: ['$avgImportance', 2] },
      },
    },
    { $sort: { count: -1, category: 1 } },
  ]);
}

// Active vs Archived with $cond, then percentages and the ratio.
async function statusRatio(userId) {
  const [stats] = await Memory.aggregate([
    { $match: { userId } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        active: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } },
        archived: { $sum: { $cond: [{ $eq: ['$status', 'Archived'] }, 1, 0] } },
      },
    },
    {
      $project: {
        _id: 0,
        total: 1,
        active: 1,
        archived: 1,
        ratio: { $concat: [{ $toString: '$active' }, ':', { $toString: '$archived' }] },
        activePercent: { $round: [{ $multiply: [{ $divide: ['$active', '$total'] }, 100] }, 1] },
        archivedPercent: { $round: [{ $multiply: [{ $divide: ['$archived', '$total'] }, 100] }, 1] },
        // Active memories per archived memory (null when nothing is archived)
        activeToArchived: {
          $cond: [{ $eq: ['$archived', 0] }, null, { $round: [{ $divide: ['$active', '$archived'] }, 2] }],
        },
      },
    },
  ]);
  return stats || { total: 0, active: 0, archived: 0, ratio: '0:0', activePercent: 0, archivedPercent: 0, activeToArchived: null };
}

// Full-text search inside the user's own memories, ranked by relevance. Results are ordered by score
// rather than _id, so this endpoint returns the top ?limit= matches instead of using a cursor.
async function searchMemories(userId, query) {
  if (typeof query.q !== 'string' || query.q.trim() === '') {
    throw badRequest('Query parameter "q" is required, e.g. /api/memories/search?q=german');
  }
  const limit = parseLimit(query.limit);
  const results = await Memory.find({ userId, $text: { $search: query.q.trim() } }, { score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .populate(POPULATE)
    .lean();
  return { count: results.length, limit, results };
}

module.exports = {
  createMemory,
  listMemories,
  getMemory,
  updateMemory,
  deleteMemory,
  statsByCategory,
  statusRatio,
  searchMemories,
};
