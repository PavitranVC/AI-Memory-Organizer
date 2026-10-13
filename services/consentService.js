const Consent = require('../models/Consent');
const Category = require('../models/Category');
const Memory = require('../models/Memory');
const Suggestion = require('../models/Suggestion');
const { badRequest, conflict } = require('./errors');
const { withTransaction } = require('./transaction');
const erasure = require('./erasureService');

const { MODES } = Consent;
// No row = "store": the behaviour before Stage 7, and what a user who has made no choice gets.
// (GDPR Art. 9 would want explicit opt-in for special categories; see docs/PRIVACY.md, "Weak points".)
const DEFAULT_MODE = 'store';

// The user's mode for one category (by id). Used by the extractor for every candidate fact and by the memory
// service on every create, so it is one indexed lookup on { userId, categoryId }.
async function modeFor(userId, categoryId) {
  if (!categoryId) return DEFAULT_MODE;
  const row = await Consent.findOne({ userId, categoryId }).select('mode').lean();
  return row ? row.mode : DEFAULT_MODE;
}

// Refuses to store a memory in a category the user set to "never", whoever asks (the extractor or the API).
// "ask" only changes what the EXTRACTOR does; a memory the user creates themselves is their explicit choice.
async function assertMayStore(userId, categoryId) {
  if ((await modeFor(userId, categoryId)) === 'never') {
    const category = await Category.findById(categoryId).select('name').lean();
    throw conflict(`You have set consent for "${category ? category.name : categoryId}" to "never". Change it with PUT /api/me/consent/:category first.`);
  }
}

// Every category with the user's mode (the default for categories they have not set)
async function listConsent(userId) {
  const [categories, rows] = await Promise.all([
    Category.find().select('name').sort({ name: 1 }).lean(),
    Consent.find({ userId }).lean(),
  ]);
  const byCategory = new Map(rows.map((r) => [String(r.categoryId), r]));
  return {
    default: DEFAULT_MODE,
    modes: MODES,
    consent: categories.map((c) => {
      const row = byCategory.get(String(c._id));
      return { categoryId: c._id, category: c.name, mode: row ? row.mode : DEFAULT_MODE, updatedAt: row ? row.updatedAt : null };
    }),
  };
}

// Sets the mode for one category. Withdrawing consent ("never") also ERASES what is already stored in that
// category (every version, plus pending suggestions), unless the body says eraseExisting: false: withdrawal
// means "stop processing", and keeping the old facts would still be processing them.
async function setConsent(userId, categoryId, body = {}) {
  const { mode } = body;
  if (!MODES.includes(mode)) throw badRequest(`mode must be one of: ${MODES.join(', ')}`);
  if (body.eraseExisting !== undefined && typeof body.eraseExisting !== 'boolean') throw badRequest('eraseExisting must be true or false');
  const eraseExisting = mode === 'never' && body.eraseExisting !== false;

  return withTransaction(async (session) => {
    const at = new Date();
    const row = await Consent.findOneAndUpdate({ userId, categoryId }, { $set: { mode } }, { upsert: true, new: true, session, runValidators: true });
    const result = { categoryId, mode: row.mode, updatedAt: row.updatedAt, erased: null };
    if (eraseExisting) {
      const versions = await Memory.find({ userId, categoryId }).select('_id').session(session).lean();
      const counts = await erasure.eraseVersions(userId, versions.map((v) => v._id), session, { at, reason: 'consent withdrawn for this category' });
      const suggestions = await Suggestion.deleteMany({ userId, categoryId }, { session });
      result.erased = { ...counts, deletedSuggestions: suggestions.deletedCount };
    }
    return result;
  });
}

module.exports = { MODES, DEFAULT_MODE, modeFor, assertMayStore, listConsent, setConsent };
