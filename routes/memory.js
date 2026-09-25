const express = require('express');
const mongoose = require('mongoose');

const Memory = require('../models/Memory');
const Category = require('../models/Category');
const User = require('../models/User');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Replace ObjectId references with readable data in responses
const POPULATE = [
  { path: 'categoryId', select: 'name' },
  { path: 'userId', select: 'name email' },
];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function handleError(res, err) {
  const isClientError =
    err.status === 400 || err.name === 'ValidationError' || err.name === 'CastError';
  res.status(isClientError ? 400 : 500).json({ error: err.message });
}

// "archived" -> "Archived", so filters are case-insensitive
function capitalize(value) {
  const text = String(value).trim();
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function toObjectId(id, field = 'id') {
  if (!mongoose.isObjectIdOrHexString(id)) throw badRequest(`Invalid ${field}: ${id}`);
  return new mongoose.Types.ObjectId(String(id));
}

// Clients can send either a categoryId or a category name such as "Health"
async function resolveCategoryId({ categoryId, category }) {
  if (categoryId) return toObjectId(categoryId, 'categoryId');
  if (!category) return undefined;
  const found = await Category.findOne({ name: capitalize(category) });
  if (!found) throw badRequest(`Unknown category: ${category}`);
  return found._id;
}

// Optional ?userId= filter for the aggregations.
// aggregate() does not auto-cast strings like find() does, so we convert to an ObjectId ourselves.
function matchUser(query) {
  return query.userId ? { userId: toObjectId(query.userId, 'userId') } : {};
}

// ===========================================================================
// ADVANCED NoSQL FEATURES: aggregation pipelines + text-index search
// (declared before "/:id" so "stats" and "search" are not treated as ids)
// ===========================================================================

// GET /api/memories/stats/by-category            (optional ?userId=)
// Groups memories by category and counts them; $lookup joins in the category name.
router.get('/stats/by-category', async (req, res) => {
  try {
    const stats = await Memory.aggregate([
      { $match: matchUser(req.query) },
      {
        $group: {
          _id: '$categoryId',
          count: { $sum: 1 },
          activeCount: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } },
          avgImportance: { $avg: '$importance' },
        },
      },
      {
        $lookup: {
          from: Category.collection.name,
          localField: '_id',
          foreignField: '_id',
          as: 'category',
        },
      },
      { $unwind: '$category' },
      {
        $project: {
          _id: 0,
          categoryId: '$_id',
          category: '$category.name',
          count: 1,
          activeCount: 1,
          avgImportance: { $round: ['$avgImportance', 2] },
        },
      },
      { $sort: { count: -1, category: 1 } },
    ]);
    res.json(stats);
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/memories/stats/status-ratio           (optional ?userId=)
// Counts Active vs Archived memories with $cond, then computes percentages and the ratio.
router.get('/stats/status-ratio', async (req, res) => {
  try {
    const [stats] = await Memory.aggregate([
      { $match: matchUser(req.query) },
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
    res.json(
      stats || { total: 0, active: 0, archived: 0, ratio: '0:0', activePercent: 0, archivedPercent: 0, activeToArchived: null }
    );
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/memories/search?q=peanut
// Full-text search using the text index on content + tags, ranked by relevance score.
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) throw badRequest('Query parameter "q" is required, e.g. /api/memories/search?q=german');

    const results = await Memory.find({ $text: { $search: q } }, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .populate(POPULATE)
      .lean();
    res.json({ count: results.length, results });
  } catch (err) {
    handleError(res, err);
  }
});

// ===========================================================================
// CRUD
// ===========================================================================

// CREATE: POST /api/memories
// Body: { userId, content, category: "Health" (or categoryId), importance?, status?, tags?, conversationId? }
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const { userId, conversationId, content, importance, status, tags } = body;

    // MongoDB has no foreign keys, so the user reference is checked here
    if (!userId) throw badRequest('userId is required');
    if (!(await User.exists({ _id: toObjectId(userId, 'userId') }))) {
      throw badRequest(`No user found with id ${userId}`);
    }

    const memory = await Memory.create({
      userId,
      conversationId,
      categoryId: await resolveCategoryId(body),
      content,
      importance,
      status,
      tags,
    });
    await memory.populate(POPULATE);
    res.status(201).json(memory);
  } catch (err) {
    handleError(res, err);
  }
});

// READ ALL: GET /api/memories?userId=&status=&category=&minImportance=
// The filters hit the userId / status / categoryId indexes.
router.get('/', async (req, res) => {
  try {
    const { userId, status, category, categoryId, minImportance } = req.query;
    const filter = {};
    if (userId) filter.userId = toObjectId(userId, 'userId');
    if (status) filter.status = capitalize(status);
    if (category || categoryId) filter.categoryId = await resolveCategoryId({ category, categoryId });
    if (minImportance) filter.importance = { $gte: Number(minImportance) };

    const memories = await Memory.find(filter).populate(POPULATE).sort({ importance: -1, createdAt: -1 });
    res.json({ count: memories.length, memories });
  } catch (err) {
    handleError(res, err);
  }
});

// READ ONE: GET /api/memories/:id
router.get('/:id', async (req, res) => {
  try {
    const memory = await Memory.findById(toObjectId(req.params.id)).populate([
      ...POPULATE,
      { path: 'conversationId', select: 'title' },
    ]);
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    res.json(memory);
  } catch (err) {
    handleError(res, err);
  }
});

// UPDATE: PUT /api/memories/:id
// Body: any of { content, category / categoryId, importance, status, tags }
router.put('/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const updates = {};
    for (const field of ['content', 'importance', 'status', 'tags']) {
      if (body[field] !== undefined) updates[field] = body[field];
    }
    const categoryId = await resolveCategoryId(body);
    if (categoryId) updates.categoryId = categoryId;
    if (Object.keys(updates).length === 0) {
      throw badRequest('Provide at least one of: content, category, importance, status, tags');
    }

    const memory = await Memory.findByIdAndUpdate(toObjectId(req.params.id), updates, {
      new: true, // return the updated document
      runValidators: true, // enforce enum / min / max rules on updates too
    }).populate(POPULATE);
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    res.json(memory);
  } catch (err) {
    handleError(res, err);
  }
});

// DELETE: DELETE /api/memories/:id
router.delete('/:id', async (req, res) => {
  try {
    const memory = await Memory.findByIdAndDelete(toObjectId(req.params.id));
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    res.json({ message: 'Memory deleted successfully', deleted: memory });
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
