const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

// Stage 7: a fact the extractor found in a category the user set to "ask". It is NOT a memory: retrieval,
// /api/ask and the memory lists never read this collection. The user accepts it (it becomes a memory) or
// rejects it (it is deleted). It points at its source message, so erasing that message erases it too.
const suggestionSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    conversationId: { type: ObjectId, ref: 'Conversation', required: true },
    messageId: { type: ObjectId, ref: 'Message', required: true }, // provenance (lineage) of the fact
    categoryId: { type: ObjectId, ref: 'Category', required: true },
    content: { type: String, required: true, trim: true, maxlength: 500 },
    topic: { type: String, default: null },
    importance: { type: Number, min: 1, max: 5, default: 3 },
    confidence: { type: Number, min: 0, max: 1, default: 1 },
    sensitivity: { type: String, enum: ['normal', 'personal', 'special'], default: 'normal' },
    validFrom: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false }
);

// My pending suggestions, newest first. E: userId. S: _id.
suggestionSchema.index({ userId: 1, _id: -1 });
// Lineage: erasing a message removes the suggestions made from it. Unique on content, so a retried job
// cannot suggest the same fact twice. E: userId, messageId (content).
suggestionSchema.index({ userId: 1, messageId: 1, content: 1 }, { unique: true });
// Deleting a category removes its suggestions. E: categoryId.
suggestionSchema.index({ categoryId: 1 });

module.exports = mongoose.model('Suggestion', suggestionSchema);
