const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

// One row per LLM call (Stage 3), for the cost analysis. Only metadata is stored: no prompt or answer text,
// so this log holds no personal data beyond the userId it is scoped to.
const llmCallSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', default: null },
    jobId: { type: ObjectId, ref: 'Job', default: null },
    task: { type: String, required: true }, // "extract" or "reconcile"
    provider: { type: String, required: true }, // "mock", "anthropic" or "ollama"
    model: { type: String, required: true }, // the model that was asked
    servedModel: { type: String, default: null }, // the model that answered (differs after a refusal fallback)
    promptId: { type: String, required: true }, // e.g. "extract.v1" (the file in prompts/)
    promptHash: { type: String, required: true }, // sha256 prefix of the prompt text: catches edits without a version bump
    status: { type: String, enum: ['ok', 'error', 'refusal'], required: true },
    stopReason: { type: String, default: null },
    error: { type: String, default: null },
    inputTokens: { type: Number, default: 0 }, // uncached input tokens
    outputTokens: { type: Number, default: 0 }, // includes thinking tokens
    cacheReadTokens: { type: Number, default: 0 }, // prompt-cache hits (billed at ~5-10% of input)
    cacheWriteTokens: { type: Number, default: 0 }, // tokens written to the prompt cache
    // true for the mock provider: its token counts are a characters/4 estimate, not a real tokenizer
    tokensEstimated: { type: Boolean, default: false },
    latencyMs: { type: Number, required: true }, // all attempts together
    attempts: { type: Number, default: 1 }, // Stage 3b: Ollama retries once inside one call (timeout, invalid JSON)
    costUsd: { type: Number, default: null }, // null = no price known for this model; 0 for the mock and Ollama
    at: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: 'llmcalls' }
);

// A user's calls, newest first. E: userId. S: _id.
llmCallSchema.index({ userId: 1, _id: -1 });
// The calls of one job. E: jobId.
llmCallSchema.index({ jobId: 1 });

module.exports = mongoose.model('LlmCall', llmCallSchema);
