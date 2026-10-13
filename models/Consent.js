const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

// What the user allows the extractor to do with facts of one category (Stage 7):
//  - store: save them as memories (the default when no row exists)
//  - ask:   keep them as suggestions until the user accepts or rejects each one
//  - never: do not keep them at all
const MODES = ['store', 'ask', 'never'];

// One row per (user, category) the user has made a choice about. A separate collection rather than an array
// on the user, so a category delete can remove its rows with one indexed deleteMany.
const consentSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    categoryId: { type: ObjectId, ref: 'Category', required: true },
    mode: { type: String, enum: { values: MODES, message: `mode must be one of: ${MODES.join(', ')}` }, required: true },
  },
  { timestamps: true, versionKey: false } // updatedAt = when the user last changed their mind (proof of consent)
);

// One choice per user and category; also serves "all of my settings" (prefix userId). E: userId, categoryId.
consentSchema.index({ userId: 1, categoryId: 1 }, { unique: true });
// Deleting a category removes every user's setting for it. E: categoryId.
consentSchema.index({ categoryId: 1 });

module.exports = mongoose.model('Consent', consentSchema);
module.exports.MODES = MODES;
