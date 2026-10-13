const mongoose = require('mongoose');
const { datasetField, sourceSchema } = require('./dataset');

const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: [true, 'conversationId is required'],
    },
    role: { type: String, enum: ['user', 'assistant'], required: [true, 'role is required'] },
    content: { type: String, required: [true, 'content is required'], trim: true, maxlength: 10000 },
    sentAt: { type: Date, default: Date.now },
    // Stage 5: set only on messages loaded from a dataset (for LoCoMo: the dialog id, e.g. 'D1:3', and speaker)
    dataset: datasetField,
    source: { type: sourceSchema, default: undefined },
  },
  { versionKey: false }
);

// Query: { conversationId } ordered by sentAt (the order a chat is read in).
// Equality on conversationId, then the sort key: reads one conversation's messages in order from the index.
messageSchema.index({ conversationId: 1, sentAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
