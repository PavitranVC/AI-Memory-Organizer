// LLM settings, all read from environment variables (never hard-coded keys).
// Read on every call rather than once at start-up, so tests and scripts can switch provider.
const DEFAULT_MODEL = 'claude-opus-5-5';
const PROVIDERS = ['mock', 'anthropic'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function llmConfig(env = process.env) {
  const provider = (env.LLM_PROVIDER || 'mock').toLowerCase();
  if (!PROVIDERS.includes(provider)) throw new Error(`LLM_PROVIDER must be one of: ${PROVIDERS.join(', ')}`);
  const effort = (env.LLM_EFFORT || 'medium').toLowerCase();
  if (!EFFORTS.includes(effort)) throw new Error(`LLM_EFFORT must be one of: ${EFFORTS.join(', ')}`);
  return {
    provider,
    models: {
      extract: env.EXTRACTION_MODEL || DEFAULT_MODEL,
      reconcile: env.RECONCILE_MODEL || DEFAULT_MODEL,
      answer: env.ANSWER_MODEL || DEFAULT_MODEL, // Stage 4: POST /api/ask
      judge: env.JUDGE_MODEL || DEFAULT_MODEL, // used by the Stage 6 evaluation
    },
    effort,
    // Server-side refusal fallback: if a safety classifier declines, the API re-runs the request on a
    // fallback model. "default" lets Anthropic pick it per refusal category; "off" disables it.
    fallbacks: (env.LLM_FALLBACKS || 'default').toLowerCase() === 'off' ? null : 'default',
  };
}

module.exports = { llmConfig, DEFAULT_MODEL, PROVIDERS };
