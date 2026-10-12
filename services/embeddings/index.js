const { embeddingConfig } = require('./config');
const { MockEmbeddingProvider } = require('./mockProvider');
const { LexicalEmbeddingProvider } = require('./lexicalProvider');
const { VoyageEmbeddingProvider } = require('./voyageProvider');
const { cosine } = require('./hashing');

// Every embedding in the project goes through this module. A provider has { name, id, dims } and
// embed(texts, { inputType }) -> one vector per text. "id" names the model AND its dimensions; it is stored
// on each memory (embeddingModel), so vectors from different models are never compared with each other.

let override = null; // a provider set by tests or scripts (setEmbedder), instead of the one from the env

function getEmbedder(config = embeddingConfig()) {
  if (override) return override;
  if (config.provider === 'mock') return new MockEmbeddingProvider();
  if (config.provider === 'voyage') return new VoyageEmbeddingProvider(config.voyage);
  return new LexicalEmbeddingProvider();
}

function setEmbedder(provider) {
  override = provider;
}

// The id of the configured model, or null if it cannot be built (e.g. voyage without a key)
function currentModelId() {
  try {
    return getEmbedder().id;
  } catch (err) {
    return null;
  }
}

// The text that represents a memory version: its sentence plus its tags (the topic is stored as a tag)
function memoryText(memory) {
  return [memory.content, ...(memory.tags || [])].filter(Boolean).join(' ');
}

function checkVectors(provider, texts, vectors) {
  if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error(`${provider.name}: expected ${texts.length} vectors`);
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== provider.dims || !v.every(Number.isFinite)) {
      throw new Error(`${provider.name}: every vector must have ${provider.dims} finite numbers`);
    }
  }
  return vectors;
}

async function embedDocuments(texts, provider = getEmbedder()) {
  const vectors = await provider.embed(texts, { inputType: 'document' });
  return { model: provider.id, vectors: checkVectors(provider, texts, vectors) };
}

async function embedQuery(text, provider = getEmbedder()) {
  const [vector] = checkVectors(provider, [text], await provider.embed([text], { inputType: 'query' }));
  return { model: provider.id, vector, minVector: provider.minVector };
}

// The embedding fields for a memory version about to be written. Embedding is a derived value, like an index
// entry: if the provider is down the memory is still saved (without a vector) and "npm run embed:backfill"
// fills it in later. Until then keyword search still finds it.
async function embeddingFields(memory) {
  try {
    const { model, vectors } = await embedDocuments([memoryText(memory)]);
    return { embedding: vectors[0], embeddingModel: model };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') console.warn(`Embedding skipped (run "npm run embed:backfill" later): ${err.message}`);
    return { embedding: undefined, embeddingModel: null };
  }
}

module.exports = { getEmbedder, setEmbedder, currentModelId, memoryText, embedDocuments, embedQuery, embeddingFields, cosine };
