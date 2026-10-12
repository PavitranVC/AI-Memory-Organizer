const mongoose = require('mongoose');

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
  },
  { versionKey: false }
);

// Query: { conversationId } ordered by sentAt (the order a chat is read in).
// Equality on conversationId, then the sort key: reads one conversation's messages in order from the index.
messageSchema.index({ conversationId: 1, sentAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
