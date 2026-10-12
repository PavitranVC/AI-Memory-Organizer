const Category = require('../models/Category');
const Memory = require('../models/Memory');
const Consent = require('../models/Consent');
const Suggestion = require('../models/Suggestion');
const { withTransaction } = require('./transaction');
const { badRequest, notFound, conflict } = require('./errors');
const { toObjectId } = require('./ids');
const { paginate } = require('./pagination');
const { requireString } = require('./authService');

// Name lookups use the same case-insensitive collation as the unique index
const BY_NAME = { locale: 'en', strength: 2 };

function findByName(name) {
  return Category.findOne({ name: requireString(name, 'category') }).collation(BY_NAME);
}

// Clients can send either a categoryId or a category name such as "health".
// Returns undefined if neither is given; throws 400 if the category does not exist.
async function resolveCategoryId({ categoryId, category } = {}) {
  if (categoryId !== undefined && categoryId !== null) {
    const id = toObjectId(categoryId, 'categoryId');
    if (!(await Category.exists({ _id: id }))) throw badRequest(`Unknown categoryId: ${id}`);
    return id;
  }
  if (category === undefined || category === null) return undefined;
  const found = await findByName(category).select('_id');
  if (!found) throw badRequest(`Unknown category: ${category}`);
  return found._id;
}

async function listCategories(query) {
  const { items, limit, nextCursor } = await paginate(Category, {}, query, { order: 'asc' });
  return { count: items.length, limit, nextCursor, categories: items };
}

async function getCategory(id) {
  const category = await Category.findById(toObjectId(id));
  if (!category) throw notFound('Category not found');
  return category;
}

async function createCategory({ name, description } = {}) {
  try {
    return await Category.create({ name: requireString(name, 'name'), description });
  } catch (err) {
    if (err.code === 11000) throw conflict(`Category "${name}" already exists`);
    throw err;
  }
}

async function updateCategory(id, { name, description } = {}) {
  const updates = {};
  if (name !== undefined) updates.name = requireString(name, 'name');
  if (description !== undefined) updates.description = description;
  if (Object.keys(updates).length === 0) throw badRequest('Provide at least one of: name, description');
  try {
    const category = await Category.findByIdAndUpdate(toObjectId(id), updates, { new: true, runValidators: true });
    if (!category) throw notFound('Category not found');
    return category;
  } catch (err) {
    if (err.code === 11000) throw conflict(`Category "${name}" already exists`);
    throw err;
  }
}

// MongoDB has no ON DELETE RESTRICT, so the check is done here. Every version the database still believes
// counts (current and superseded ones), so the history never points at a missing category. Retracted
// (deleted) versions do not block it.
async function deleteCategory(id) {
  const categoryId = toObjectId(id);
  const inUse = await Memory.countDocuments({ categoryId, retractedAt: null });
  if (inUse > 0) throw conflict(`Category is used by ${inUse} memories (including past versions); move or delete them first`);
  // Stage 7: every user's consent setting and pending suggestions for it go with it (no dangling references)
  return withTransaction(async (session) => {
    const category = await Category.findByIdAndDelete(categoryId, { session });
    if (!category) throw notFound('Category not found');
    await Consent.deleteMany({ categoryId }, { session });
    await Suggestion.deleteMany({ categoryId }, { session });
    return category;
  });
}

module.exports = { resolveCategoryId, listCategories, getCategory, createCategory, updateCategory, deleteCategory };
