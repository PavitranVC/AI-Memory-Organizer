const mongoose = require('mongoose');

// Messages are embedded sub-documents (NoSQL denormalisation):
// a whole conversation is read in a single query, with no join needed.
const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true, trim: true },
    sentAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: [true, 'userId is required'] },
    title: { type: String, required: [true, 'title is required'], trim: true },
    messages: [messageSchema],
  },
  { timestamps: true }
);

// A user's conversations, newest first
conversationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
