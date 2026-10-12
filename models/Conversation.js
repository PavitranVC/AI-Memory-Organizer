const mongoose = require('mongoose');
const { datasetField, sourceSchema } = require('./dataset');

// Messages live in their own collection (see Message.js): an embedded array would grow without
// bound and hit MongoDB's 16 MB document limit in long chats.
const conversationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: [true, 'userId is required'] },
    title: { type: String, required: [true, 'title is required'], trim: true, maxlength: 200 },
    // Stage 5: set only on conversations loaded from a dataset (for LoCoMo: sample id + session number)
    dataset: datasetField,
    source: { type: sourceSchema, default: undefined },
  },
  { timestamps: true }
);

// Query: { userId } sorted by _id descending (newest first, the keyset pagination order).
// Equality on userId, then the sort key, so the index returns rows already in order: no SORT stage.
conversationSchema.index({ userId: 1, _id: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
