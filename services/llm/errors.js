// Errors from the LLM layer. "retryable" tells the job worker whether trying again can help:
// a rate limit or a network error can, a refusal or a bad API key cannot.
class LlmError extends Error {
  constructor(message, { retryable = true, stopReason = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.retryable = retryable;
    this.stopReason = stopReason;
  }
}

// The model declined the request (stop_reason "refusal"). Retrying the same input gives the same answer.
class LlmRefusalError extends LlmError {
  constructor(message, { category = null } = {}) {
    super(message, { retryable: false, stopReason: 'refusal' });
    this.name = 'LlmRefusalError';
    this.category = category;
  }
}

module.exports = { LlmError, LlmRefusalError };
