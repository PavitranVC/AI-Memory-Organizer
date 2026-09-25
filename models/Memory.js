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
    importance: { type: Number, min: 1, max: 5, default: 3 },
    status: { type: String, enum: ['Active', 'Archived'], default: 'Active' },
    tags: [{ type: String, trim: true, lowercase: true }],
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// Indexes (advanced NoSQL feature): speed up the most common queries
// ---------------------------------------------------------------------------
memorySchema.index({ userId: 1 }); // all memories of one user
memorySchema.index({ categoryId: 1 }); // filter / group by category
memorySchema.index({ status: 1 }); // Active vs Archived
// Compound index: a user's memories filtered by status, most important first
memorySchema.index({ userId: 1, status: 1, importance: -1 });
// Text index: keyword search over content and tags (GET /api/memories/search)
memorySchema.index({ content: 'text', tags: 'text' });

module.exports = mongoose.model('Memory', memorySchema);
