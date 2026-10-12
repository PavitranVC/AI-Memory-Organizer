const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

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
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// Indexes, designed with the ESR rule: Equality fields first, then the Sort field, then Range fields.
// Every list is paginated newest-first on _id, so _id is the sort key everywhere.
// A standalone { userId } and { status } index are deliberately absent: userId is a prefix of the
// indexes below, and status has only two values, so on its own it filters almost nothing.
// ---------------------------------------------------------------------------

// All of a user's memories. E: userId, S: _id. Also the prefix the $match of both aggregations uses.
memorySchema.index({ userId: 1, _id: -1 });
// A user's Active / Archived memories. E: userId, status, S: _id.
memorySchema.index({ userId: 1, status: 1, _id: -1 });
// A user's memories in one category. E: userId, categoryId, S: _id.
// (minImportance is a range on a non-indexed field, so it is applied while fetching documents.)
memorySchema.index({ userId: 1, categoryId: 1, _id: -1 });
// "Does this category still have memories?" (blocks deleting it) crosses users, so it cannot use a userId prefix. E: categoryId.
memorySchema.index({ categoryId: 1 });
// Keyword search. A text index can only be combined with equality fields, so the userId prefix keeps a
// search inside one user's data; every search query must therefore include userId.
memorySchema.index({ userId: 1, content: 'text', tags: 'text' });

module.exports = mongoose.model('Memory', memorySchema);
