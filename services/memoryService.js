const Memory = require('../models/Memory');
const Category = require('../models/Category');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { badRequest, notFound, conflict } = require('./errors');
const { toObjectId } = require('./ids');
const { paginate, parseLimit } = require('./pagination');
const { resolveCategoryId } = require('./categoryService');
const { withTransaction } = require('./transaction');
const audit = require('./auditService');

const STATUSES = ['Active', 'Archived'];
const POPULATE = [{ path: 'categoryId', select: 'name' }];
// The version a user sees today: still true (validTo) and still believed (retractedAt)
const CURRENT = Object.freeze({ validTo: null, retractedAt: null });
// Categories whose memories default to sensitivity "special" (health data is a special category under GDPR Art. 9;
// the full legal mapping is Stage 7)
const SPECIAL_CATEGORIES = ['health'];
const MAX_SOURCES = 50;

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

// An ISO 8601 date or date-time, e.g. 2025-03-01 or 2025-03-01T10:00:00Z
function parseInstant(value, field) {
  const date = typeof value === 'string' && value.trim() !== '' ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) throw badRequest(`${field} must be an ISO date, e.g. 2025-03-01T10:00:00Z`);
  return date;
}

// The start of a fact's valid time may be in the past ("I have lived in Pune since 2020"), never in the
// future: then "current" can stay the simple equality validTo = null (see the indexes in models/Memory.js).
function parseValidFrom(value, now) {
  const date = value instanceof Date ? value : parseInstant(value, 'validFrom');
  if (date > now) throw badRequest('validFrom cannot be in the future');
  return date;
}

// Builds the filter for "what did we believe at knownAt about what was true at asOf?".
//  - neither:     current state (validTo = null AND retractedAt = null), an equality the indexes serve
//  - asOf=T:      valid time only, with today's knowledge: validFrom <= T < validTo, not retracted
//  - knownAt=K:   transaction time: the rows the database held at K, and what it then thought was true at K
//  - both:        valid time T as known at K
// A version's validTo was only known from closedAt on, so before that it counts as still open.
function temporalFilter(query = {}) {
  const asOf = query.asOf !== undefined ? parseInstant(query.asOf, 'asOf') : null;
  const knownAt = query.knownAt !== undefined ? parseInstant(query.knownAt, 'knownAt') : null;
  if (!asOf && !knownAt) return { filter: { ...CURRENT }, asOf, knownAt };

  const t = asOf || knownAt;
  if (!knownAt) {
    return { filter: { validFrom: { $lte: t }, retractedAt: null, $or: [{ validTo: null }, { validTo: { $gt: t } }] }, asOf, knownAt };
  }
  const filter = {
    validFrom: { $lte: t },
    recordedAt: { $lte: knownAt },
    $and: [
      { $or: [{ retractedAt: null }, { retractedAt: { $gt: knownAt } }] },
      { $or: [{ validTo: null }, { validTo: { $gt: t } }, { closedAt: { $gt: knownAt } }] },
    ],
  };
  return { filter, asOf, knownAt };
}

function parseConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw badRequest('confidence must be a number between 0 and 1');
  }
  return value;
}

// MongoDB has no foreign keys. A memory may only point at a conversation that exists AND is the caller's own.
// Returns the caller's own conversation (its id and dataset label), or a 400 if it is not theirs
async function findOwnConversation(userId, conversationId) {
  const id = toObjectId(conversationId, 'conversationId');
  const conversation = await Conversation.findOne({ _id: id, userId }).select('dataset').lean();
  if (!conversation) throw badRequest(`Unknown conversationId: ${id}`);
  return conversation;
}

async function assertOwnConversation(userId, conversationId) {
  return (await findOwnConversation(userId, conversationId))._id;
}

// Provenance: every source must be a message in one of the caller's own conversations
async function assertOwnMessages(userId, ids) {
  if (!Array.isArray(ids)) throw badRequest('sourceMessageIds must be an array of message ids');
  if (ids.length > MAX_SOURCES) throw badRequest(`sourceMessageIds can hold at most ${MAX_SOURCES} ids`);
  const unique = [...new Set(ids.map((id) => String(toObjectId(id, 'sourceMessageIds'))))].map((id) => toObjectId(id));
  if (unique.length === 0) return [];
  const messages = await Message.find({ _id: { $in: unique } }).select('conversationId').lean();
  const conversationIds = [...new Set(messages.map((m) => String(m.conversationId)))];
  const owned = await Conversation.countDocuments({ _id: { $in: conversationIds }, userId });
  if (messages.length !== unique.length || owned !== conversationIds.length) {
    throw badRequest('Unknown sourceMessageIds: every id must be a message in one of your conversations');
  }
  return unique;
}

async function isSpecialCategory(categoryId) {
  const category = await Category.findById(categoryId).select('name').lean();
  return Boolean(category) && SPECIAL_CATEGORIES.includes(category.name.toLowerCase());
}

// Every function takes the authenticated user's id first and puts it in the query filter, so a user can
// never read or change another user's memories, whatever ids the request contains.

// Who made a change, for the audit log. A client request is the user acting through the API. The Stage 3
// extractor passes { actorId: null, via: 'extractor', reason } because no person made that decision.
function actor(userId, options = {}) {
  return {
    actorId: options.actorId !== undefined ? options.actorId : userId,
    via: options.via || 'api',
    reason: options.reason || null,
  };
}

async function createMemory(userId, body = {}, options = {}) {
  const { content, importance, status, tags } = body;
  const now = new Date();
  const categoryId = await resolveCategoryId(body);
  const conversation = body.conversationId ? await findOwnConversation(userId, body.conversationId) : null;
  const doc = {
    userId,
    conversationId: conversation ? conversation._id : undefined,
    // Stage 5: a memory extracted from benchmark (or synthetic) messages carries the same dataset label, so
    // results never mix benchmark and real data. Clients cannot set it.
    dataset: conversation && conversation.dataset ? conversation.dataset : undefined,
    categoryId,
    content,
    importance,
    status,
    tags,
    validFrom: body.validFrom !== undefined ? parseValidFrom(body.validFrom, now) : now,
    recordedAt: now, // transaction time always comes from the server clock
    sourceMessageIds: body.sourceMessageIds !== undefined ? await assertOwnMessages(userId, body.sourceMessageIds) : [],
    confidence: body.confidence !== undefined ? parseConfidence(body.confidence) : undefined,
    // Health facts are "special" unless the client says otherwise
    sensitivity: body.sensitivity !== undefined ? body.sensitivity : categoryId && (await isSpecialCategory(categoryId)) ? 'special' : undefined,
  };

  const memory = await withTransaction(async (session) => {
    const [created] = await Memory.create([doc], { session });
    await audit.record({ userId, memoryId: created._id, action: 'create', ...actor(userId, options), at: now, after: created }, session);
    return created;
  });
  await memory.populate(POPULATE);
  return memory;
}

async function listMemories(userId, query) {
  const { filter: temporal, asOf, knownAt } = temporalFilter(query);
  const filter = { userId, ...temporal };
  if (query.status !== undefined) filter.status = parseStatus(query.status);
  if (query.category !== undefined || query.categoryId !== undefined) {
    filter.categoryId = await resolveCategoryId({ category: query.category, categoryId: query.categoryId });
  }
  if (query.minImportance !== undefined) filter.importance = { $gte: parseMinImportance(query.minImportance) };

  const { items, limit, nextCursor } = await paginate(Memory, filter, query, { populate: POPULATE });
  return { count: items.length, limit, nextCursor, asOf, knownAt, memories: items };
}

// Any version the database still believes (current or superseded). Reading it counts as an access:
// usage is bookkeeping, so it is updated in place and does not create a version or touch updatedAt.
async function getMemory(userId, id) {
  const memory = await Memory.findOneAndUpdate(
    { _id: toObjectId(id), userId, retractedAt: null },
    { $set: { lastAccessedAt: new Date() }, $inc: { accessCount: 1 } },
    { new: true, timestamps: false }
  ).populate([...POPULATE, { path: 'conversationId', select: 'title' }]);
  if (!memory) throw notFound('Memory not found');
  return memory;
}

// The fields a client may change. Anything else (userId, recordedAt, supersedes, ...) is ignored.
const EDITABLE = ['content', 'importance', 'status', 'tags', 'categoryId', 'conversationId', 'confidence', 'sensitivity', 'sourceMessageIds', 'validFrom'];
const COPIED = ['conversationId', 'dataset', 'categoryId', 'content', 'importance', 'status', 'tags', 'sourceMessageIds', 'confidence', 'sensitivity', 'lastAccessedAt', 'accessCount'];

// An update never overwrites a version. It creates a new version and closes the old one, in one transaction:
//  - SUPERSEDE (default): the fact changed in the world. The old version stays believed, but its valid time
//    ends where the new one starts (validTo = the new validFrom, which defaults to now).
//  - CORRECTION (body.correction = true): the old version was wrong all along. It is retracted (transaction
//    time ends) and the new version takes over its valid time.
// Only the current version can be updated; updating an older one is a 409 that names its successor.
async function updateMemory(userId, id, body = {}, options = {}) {
  const memoryId = toObjectId(id);
  const correction = body.correction === true;
  if (body.correction !== undefined && typeof body.correction !== 'boolean') throw badRequest('correction must be true or false');
  if (correction && body.validFrom !== undefined) throw badRequest('A correction keeps the old valid time; do not send validFrom');
  if (!EDITABLE.some((field) => body[field] !== undefined) && body.category === undefined) {
    throw badRequest('Provide at least one of: content, category, importance, status, tags, conversationId, confidence, sensitivity, sourceMessageIds, validFrom');
  }

  // Validate every reference before the transaction starts
  const changes = {};
  for (const field of ['content', 'importance', 'status', 'tags', 'sensitivity']) {
    if (body[field] !== undefined) changes[field] = body[field];
  }
  const categoryId = await resolveCategoryId(body);
  if (categoryId) changes.categoryId = categoryId;
  if (body.conversationId !== undefined) {
    // null detaches the memory from its conversation
    changes.conversationId = body.conversationId === null ? null : await assertOwnConversation(userId, body.conversationId);
  }
  if (body.confidence !== undefined) changes.confidence = parseConfidence(body.confidence);
  if (body.sourceMessageIds !== undefined) changes.sourceMessageIds = await assertOwnMessages(userId, body.sourceMessageIds);
  if (categoryId && body.sensitivity === undefined && (await isSpecialCategory(categoryId))) changes.sensitivity = 'special';

  const created = await withTransaction(async (session) => {
    const now = new Date();
    const old = await Memory.findOne({ _id: memoryId, userId, retractedAt: null }).session(session);
    if (!old) throw notFound('Memory not found');
    if (old.validTo !== null || old.supersededBy) {
      throw conflict(`This version is no longer current${old.supersededBy ? `; it was superseded by ${old.supersededBy}` : ''}. Update the current version.`);
    }
    const effectiveFrom = correction ? old.validFrom : body.validFrom !== undefined ? parseValidFrom(body.validFrom, now) : now;
    if (!correction && effectiveFrom <= old.validFrom) {
      throw badRequest(`validFrom must be after the old version's validFrom (${old.validFrom.toISOString()}); to fix a mistake, send "correction": true`);
    }

    const next = Object.fromEntries(COPIED.map((field) => [field, old[field]]));
    const [version] = await Memory.create(
      [{ ...next, ...changes, userId, validFrom: effectiveFrom, validTo: null, recordedAt: now, supersedes: old._id }],
      { session }
    );

    // Close the old version. The filter re-checks that it is still current, so two concurrent updates of the
    // same version cannot both succeed (the unique index on "supersedes" also guarantees it).
    const close = correction
      ? { retractedAt: now, supersededBy: version._id }
      : { validTo: effectiveFrom, closedAt: now, supersededBy: version._id };
    const closed = await Memory.findOneAndUpdate({ _id: old._id, ...CURRENT, supersededBy: null }, { $set: close }, { new: true, session });
    if (!closed) throw conflict('This memory was changed by another request; reload it and try again');

    await audit.record(
      { userId, memoryId: version._id, action: correction ? 'correct' : 'supersede', ...actor(userId, options), at: now, before: old, after: version },
      session
    );
    return version;
  });
  await created.populate(POPULATE);
  return created;
}

// Deleting is a RETRACTION: the version stays in the database with retractedAt set, so the history and
// "?knownAt=" queries still show that it was once believed. (Hard erasure is a Stage 7 feature.)
async function deleteMemory(userId, id) {
  const memoryId = toObjectId(id);
  return withTransaction(async (session) => {
    const now = new Date();
    const old = await Memory.findOne({ _id: memoryId, userId, retractedAt: null }).session(session);
    if (!old) throw notFound('Memory not found');
    const retracted = await Memory.findOneAndUpdate({ _id: old._id, retractedAt: null }, { $set: { retractedAt: now } }, { new: true, session });
    if (!retracted) throw conflict('This memory was changed by another request; reload it and try again');
    await audit.record({ userId, memoryId: old._id, action: 'retract', ...actor(userId), at: now, before: old, after: retracted }, session);
    return retracted;
  });
}

// The whole version chain of a memory, oldest first, starting from any of its versions.
// $graphLookup follows the links recursively (like a recursive CTE in SQL): "supersedes" backwards and
// "supersededBy" forwards. Both hops are lookups on _id, so they use the _id index.
async function getHistory(userId, id) {
  const memoryId = toObjectId(id);
  const [found] = await Memory.aggregate([
    { $match: { _id: memoryId, userId } },
    {
      $graphLookup: {
        from: Memory.collection.name,
        startWith: '$supersedes',
        connectFromField: 'supersedes',
        connectToField: '_id',
        as: 'older',
        restrictSearchWithMatch: { userId },
      },
    },
    {
      $graphLookup: {
        from: Memory.collection.name,
        startWith: '$supersededBy',
        connectFromField: 'supersededBy',
        connectToField: '_id',
        as: 'newer',
        restrictSearchWithMatch: { userId },
      },
    },
  ]);
  if (!found) throw notFound('Memory not found');
  const { older, newer, ...self } = found;
  // Versions are recorded one after another, so transaction time gives the chain order
  const versions = [...older, self, ...newer].sort((a, b) => a.recordedAt - b.recordedAt || String(a._id).localeCompare(String(b._id)));
  await Memory.populate(versions, POPULATE);
  const current = versions.find((v) => v.validTo === null && v.retractedAt === null);
  return {
    count: versions.length,
    currentId: current ? current._id : null,
    versions: versions.map((v) => ({ ...v, isCurrent: v === current })),
  };
}

// ---------------------------------------------------------------------------
// Aggregations (advanced NoSQL feature)
// ---------------------------------------------------------------------------

// The aggregations and the search only look at current versions, so a memory with three versions counts once.

// Counts per category with $group, then $lookup joins in the category name.
// The $lookup keeps memories whose category document is missing (preserveNullAndEmptyArrays) and
// labels them, so the counts always add up to the total instead of silently dropping rows.
async function statsByCategory(userId) {
  return Memory.aggregate([
    { $match: { userId, ...CURRENT } },
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
    { $match: { userId, ...CURRENT } },
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
  const results = await Memory.find({ userId, ...CURRENT, $text: { $search: query.q.trim() } }, { score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .populate(POPULATE)
    .lean();
  return { count: results.length, limit, results };
}

module.exports = {
  CURRENT,
  SPECIAL_CATEGORIES,
  MAX_SOURCES,
  createMemory,
  listMemories,
  getMemory,
  updateMemory,
  deleteMemory,
  getHistory,
  temporalFilter,
  statsByCategory,
  statusRatio,
  searchMemories,
};
