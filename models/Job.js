const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const TYPES = ['extract'];
const STATUSES = ['pending', 'running', 'done', 'failed'];

// A simple job queue kept in MongoDB (Stage 3). Posting a message inserts the message and an "extract" job in
// one transaction (the transactional outbox pattern), so a message is never saved without its job. A worker
// (services/worker.js) claims pending jobs one at a time and runs the LLM pipeline, so the API never waits
// for the LLM.
const jobSchema = new mongoose.Schema(
  {
    type: { type: String, enum: TYPES, required: true },
    userId: { type: ObjectId, ref: 'User', required: true }, // whose data the job touches (scopes every read)
    payload: {
      messageId: { type: ObjectId, ref: 'Message', required: true },
      conversationId: { type: ObjectId, ref: 'Conversation', required: true },
    },
    status: { type: String, enum: STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 3, min: 1 },
    runAt: { type: Date, default: Date.now }, // not before this time (used for retry back-off)
    lockedAt: { type: Date, default: null }, // when a worker claimed it
    lockedBy: { type: String, default: null }, // which worker (host:pid)
    error: { type: String, default: null }, // last error message
    // What the job did: one entry per candidate fact (no message text is copied here)
    result: { type: Object, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Claiming the next job: E: status = "pending", S: runAt (oldest first), R: runAt <= now.
// The sort key and the range are the same field, so one index serves both.
jobSchema.index({ status: 1, runAt: 1 });
// Recovering jobs whose worker died: E: status = "running", R: lockedAt < now - lock timeout.
jobSchema.index({ status: 1, lockedAt: 1 });
// A user's own jobs, newest first (GET /api/jobs). E: userId. S: _id.
jobSchema.index({ userId: 1, _id: -1 });
// Deleting a conversation also deletes its jobs. E: payload.conversationId.
jobSchema.index({ 'payload.conversationId': 1 });

module.exports = mongoose.model('Job', jobSchema);
module.exports.STATUSES = STATUSES;
module.exports.TYPES = TYPES;
