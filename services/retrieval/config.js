// Retrieval settings, all from environment variables, read on every call so tests and the Stage 6
// evaluation can change them. The four weights are the "w1..w4" of the hybrid score (see index.js).
const BACKENDS = ['local', 'atlas'];
const DEFAULT_WEIGHTS = Object.freeze({ text: 0.4, vector: 0.4, recency: 0.1, importance: 0.1 });
const MAX_K = 20; // never send more than this many memories to the answer model

function number(value, fallback, name, { min = 0, max = Infinity, integer = false } = {}) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`);
  }
  return n;
}

function parseWeights(weights) {
  const out = {};
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const w = weights[key] === undefined ? DEFAULT_WEIGHTS[key] : weights[key];
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) throw new Error(`weight "${key}" must be a number >= 0`);
    out[key] = w;
  }
  if (Object.values(out).every((w) => w === 0)) throw new Error('at least one retrieval weight must be above 0');
  return out;
}

function retrievalConfig(env = process.env) {
  const backend = (env.VECTOR_BACKEND || 'local').toLowerCase();
  if (!BACKENDS.includes(backend)) throw new Error(`VECTOR_BACKEND must be one of: ${BACKENDS.join(', ')}`);
  return {
    backend,
    atlasIndex: env.ATLAS_VECTOR_INDEX || 'memory_vector_index',
    // Memories sent to the answer model (top-k), and the size of each candidate list (keyword and vector)
    topK: number(env.RETRIEVAL_TOP_K, 5, 'RETRIEVAL_TOP_K', { min: 1, max: MAX_K, integer: true }),
    candidates: number(env.RETRIEVAL_CANDIDATES, 50, 'RETRIEVAL_CANDIDATES', { min: 1, max: 1000, integer: true }),
    // A memory with no keyword match needs at least this cosine similarity to count as relevant at all
    minVector: number(env.RETRIEVAL_MIN_VECTOR, 0.1, 'RETRIEVAL_MIN_VECTOR', { max: 1 }),
    // Recency halves every N days since the fact became true
    halfLifeDays: number(env.RETRIEVAL_HALF_LIFE_DAYS, 90, 'RETRIEVAL_HALF_LIFE_DAYS', { min: 1 }),
    weights: parseWeights({
      text: number(env.RETRIEVAL_W_TEXT, undefined, 'RETRIEVAL_W_TEXT'),
      vector: number(env.RETRIEVAL_W_VECTOR, undefined, 'RETRIEVAL_W_VECTOR'),
      recency: number(env.RETRIEVAL_W_RECENCY, undefined, 'RETRIEVAL_W_RECENCY'),
      importance: number(env.RETRIEVAL_W_IMPORTANCE, undefined, 'RETRIEVAL_W_IMPORTANCE'),
    }),
  };
}

module.exports = { retrievalConfig, parseWeights, DEFAULT_WEIGHTS, BACKENDS, MAX_K };
