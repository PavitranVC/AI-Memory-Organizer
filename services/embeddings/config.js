// Embedding settings, all from environment variables (keys are never hard-coded). Read on every call so tests
// and scripts can switch provider.
const PROVIDERS = ['mock', 'lexical', 'voyage'];

const positiveInt = (value, fallback, name) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number above 0`);
  return n;
};

function embeddingConfig(env = process.env) {
  // lexical is the default: offline, free and deterministic. voyage is the real semantic model (paid).
  const provider = (env.EMBEDDING_PROVIDER || 'lexical').toLowerCase();
  if (!PROVIDERS.includes(provider)) throw new Error(`EMBEDDING_PROVIDER must be one of: ${PROVIDERS.join(', ')}`);
  return {
    provider,
    voyage: { model: env.VOYAGE_MODEL || 'voyage-3.5', dims: positiveInt(env.VOYAGE_DIMENSIONS, 1024, 'VOYAGE_DIMENSIONS') },
  };
}

module.exports = { embeddingConfig, PROVIDERS };
