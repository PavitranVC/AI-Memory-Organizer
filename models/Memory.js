const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const SENSITIVITIES = ['normal', 'personal', 'special'];

// A memory is stored as a chain of immutable VERSIONS (bi-temporal model, Stage 2).
//  - Valid time      [validFrom, validTo):      when the fact was true in the user's life.
//  - Transaction time [recordedAt, retractedAt): when this database believed the version.
// "Current" versions have validTo = null and retractedAt = null. An update never edits content in place:
// it closes the old version (validTo, supersededBy) and inserts a new one (supersedes), see memoryService.
const memorySchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: [true, 'userId is required'] },
    // The conversation this memory was extracted from
    conversationId: { type: ObjectId, ref: 'Conversation' },
    // The memory's category (Learning, Personal, Health, Hobbies), stored as a reference
    categoryId: { type: ObjectId, ref: 'Category', required: [true, 'category is required'] },
    content: {
      type: String,
      required: [true, 'content is required'],
      trim: true,
      maxlength: [500, 'content cannot exceed 500 characters'],
    },
    importance: {
      type: Number,
      min: 1,
      max: 5,
      default: 3,
      validate: { validator: Number.isInteger, message: 'importance must be a whole number' },
    },
    status: { type: String, enum: ['Active', 'Archived'], default: 'Active' },
    tags: [{ type: String, trim: true, lowercase: true }],

    // --- Valid time: when the fact holds in the real world ---
    validFrom: { type: Date, required: true, default: Date.now },
    validTo: { type: Date, default: null }, // null = still true
    // --- Transaction time: when the database held this version (set by the server, never by clients) ---
    recordedAt: { type: Date, required: true, default: Date.now },
    retractedAt: { type: Date, default: null }, // null = still believed
    // Transaction time at which validTo was written (when we learned the fact had stopped being true).
    // Needed so "?knownAt=" can show validTo as it was known then, not as it is known now.
    closedAt: { type: Date, default: null },

    // --- Provenance and scoring ---
    sourceMessageIds: { type: [{ type: ObjectId, ref: 'Message' }], default: [] },
    confidence: { type: Number, min: [0, 'confidence must be between 0 and 1'], max: [1, 'confidence must be between 0 and 1'], default: 1 },
    sensitivity: { type: String, enum: { values: SENSITIVITIES, message: `sensitivity must be one of: ${SENSITIVITIES.join(', ')}` }, default: 'normal' },

    // --- Version chain (a doubly linked list of versions) ---
    supersedes: { type: ObjectId, ref: 'Memory', default: null },
    supersededBy: { type: ObjectId, ref: 'Memory', default: null },

    // --- Usage (bookkeeping, updated in place: reading a memory is not a change of belief) ---
    lastAccessedAt: { type: Date, default: null },
    accessCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// Indexes, designed with the ESR rule: Equality fields first, then the Sort field, then Range fields.
// Every list is paginated newest-first on _id, so _id is the sort key everywhere.
// "Current" is an EQUALITY match (validTo: null, retractedAt: null), which is why those two fields sit in
// the equality part of the current-state indexes instead of being range filters.
// ---------------------------------------------------------------------------

// Current memories of a user. E: userId, validTo=null, retractedAt=null. S: _id.
memorySchema.index({ userId: 1, validTo: 1, retractedAt: 1, _id: -1 });
// Current memories by status. E: userId, validTo, retractedAt, status. S: _id.
memorySchema.index({ userId: 1, validTo: 1, retractedAt: 1, status: 1, _id: -1 });
// Current memories in one category. E: userId, validTo, retractedAt, categoryId. S: _id.
// (minImportance is a range on a non-indexed field, so it is applied while fetching documents.)
memorySchema.index({ userId: 1, validTo: 1, retractedAt: 1, categoryId: 1, _id: -1 });
// Time travel (?asOf= / ?knownAt=). E: userId. S: _id. R: validFrom, recordedAt.
// The ranges come AFTER the sort key, so the scan stays in _id order (no in-memory SORT) and versions that
// started after T are skipped on the index keys alone, before any document is fetched.
memorySchema.index({ userId: 1, _id: -1, validFrom: 1, recordedAt: 1 });
// "Is this category still used by a version we believe?" (blocks deleting it). Crosses users, so no
// userId prefix. E: categoryId, retractedAt=null.
memorySchema.index({ categoryId: 1, retractedAt: 1 });
// A version can be superseded only once: two concurrent updates of the same version cannot both create a
// successor (no forked chains). Partial, because most versions supersede nothing.
memorySchema.index({ supersedes: 1 }, { unique: true, partialFilterExpression: { supersedes: { $type: 'objectId' } } });
// Keyword search. A text index can only be combined with equality fields, so the userId prefix keeps a
// search inside one user's data; every search query must therefore include userId.
memorySchema.index({ userId: 1, content: 'text', tags: 'text' });

module.exports = mongoose.model('Memory', memorySchema);
module.exports.SENSITIVITIES = SENSITIVITIES;
