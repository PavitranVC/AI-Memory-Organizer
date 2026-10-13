// LLM settings, all read from environment variables (never hard-coded keys).
// Read on every call rather than once at start-up, so tests and scripts can switch provider.
const DEFAULT_MODEL = 'claude-opus-5-5';
const PROVIDERS = ['mock', 'anthropic', 'ollama'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Stage 3b: free local models through Ollama. One model does the work and a DIFFERENT model judges, so the
// judge does not grade its own answers (self-preference bias).
const OLLAMA_DEFAULTS = {
  url: 'http://localhost:11434',
  model: 'qwen2.5-coder:14b',
  judgeModel: 'deepseek-r1:14b',
  numCtx: 8192, // extract, reconcile, judge and most answers fit in this
  numCtxLarge: 32768, // the full-context baseline: a whole LoCoMo conversation is up to ~30k tokens
  timeoutMs: 300000, // the first call also loads the model into memory, which can take a minute
};

const positiveInt = (value, fallback, name) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number above 0`);
  return n;
};

function ollamaConfig(env = process.env) {
  const numCtx = positiveInt(env.OLLAMA_NUM_CTX, OLLAMA_DEFAULTS.numCtx, 'OLLAMA_NUM_CTX');
  const numCtxLarge = positiveInt(env.OLLAMA_NUM_CTX_LARGE, OLLAMA_DEFAULTS.numCtxLarge, 'OLLAMA_NUM_CTX_LARGE');
  if (numCtxLarge < numCtx) throw new Error('OLLAMA_NUM_CTX_LARGE must not be smaller than OLLAMA_NUM_CTX');
  return {
    url: (env.OLLAMA_URL || OLLAMA_DEFAULTS.url).replace(/\/+$/, ''),
    numCtx,
    numCtxLarge,
    timeoutMs: positiveInt(env.OLLAMA_TIMEOUT_MS, OLLAMA_DEFAULTS.timeoutMs, 'OLLAMA_TIMEOUT_MS'),
  };
}

function llmConfig(env = process.env) {
  const provider = (env.LLM_PROVIDER || 'mock').toLowerCase();
  if (!PROVIDERS.includes(provider)) throw new Error(`LLM_PROVIDER must be one of: ${PROVIDERS.join(', ')}`);
  const effort = (env.LLM_EFFORT || 'medium').toLowerCase();
  if (!EFFORTS.includes(effort)) throw new Error(`LLM_EFFORT must be one of: ${EFFORTS.join(', ')}`);
  if (provider === 'ollama') {
    const model = env.OLLAMA_MODEL || OLLAMA_DEFAULTS.model;
    return {
      provider,
      models: { extract: model, reconcile: model, answer: model, judge: env.JUDGE_MODEL || OLLAMA_DEFAULTS.judgeModel },
      effort, // not used by Ollama; kept so every config has the same shape
      fallbacks: null,
      ollama: ollamaConfig(env),
    };
  }
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

module.exports = { llmConfig, ollamaConfig, DEFAULT_MODEL, PROVIDERS, OLLAMA_DEFAULTS };
