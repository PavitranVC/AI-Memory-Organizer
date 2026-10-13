// Embedding settings, all from environment variables (keys are never hard-coded). Read on every call so tests
// and scripts can switch provider.
const PROVIDERS = ['mock', 'lexical', 'voyage', 'ollama'];

const positiveInt = (value, fallback, name) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number above 0`);
  return n;
};

function embeddingConfig(env = process.env) {
  // lexical is the default: offline, free and deterministic. ollama (Stage 3b) is a real semantic model that
  // runs locally for free; voyage is a real semantic model in the cloud (paid).
  const provider = (env.EMBEDDING_PROVIDER || 'lexical').toLowerCase();
  if (!PROVIDERS.includes(provider)) throw new Error(`EMBEDDING_PROVIDER must be one of: ${PROVIDERS.join(', ')}`);
  return {
    provider,
    voyage: { model: env.VOYAGE_MODEL || 'voyage-3.5', dims: positiveInt(env.VOYAGE_DIMENSIONS, 1024, 'VOYAGE_DIMENSIONS') },
    // No dimension setting: the size comes from the model itself (see services/embeddings/ollamaProvider.js)
    ollama: {
      url: env.OLLAMA_URL || 'http://localhost:11434',
      model: env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
      timeoutMs: positiveInt(env.OLLAMA_TIMEOUT_MS, 120000, 'OLLAMA_TIMEOUT_MS'),
    },
  };
}

module.exports = { embeddingConfig, PROVIDERS };
