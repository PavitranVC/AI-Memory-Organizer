const { ollamaPost } = require('../llm/ollamaProvider');

// A real SEMANTIC embedding model that runs locally and for free through Ollama (POST /api/embed).
// Selected with EMBEDDING_PROVIDER=ollama; the model is OLLAMA_EMBED_MODEL (default nomic-embed-text).
//   POST {OLLAMA_URL}/api/embed  { model, input: [texts], truncate: true }  ->  { model, embeddings: [[...]] }
//
// The vector size comes from the model, not from this file: KNOWN_DIMS is only a first guess so the id is
// known before any call; ready() asks the server once, and every answer is checked. If the size differs
// (another model, another version), the provider takes the server's size and its id changes with it, so
// "npm run embed:backfill" re-embeds every memory that still has a vector of the old size.
const KNOWN_DIMS = { 'nomic-embed-text': 768, 'mxbai-embed-large': 1024, 'all-minilm': 384, 'bge-m3': 1024, 'snowflake-arctic-embed': 1024 };
const learned = new Map(); // `${url} ${model}` -> dims seen from the server, shared by every instance
const MAX_BATCH = 64;

// nomic-embed-text was trained with a task prefix, and retrieval is better with it (see its model card)
function withPrefix(model, text, inputType) {
  if (!model.startsWith('nomic-embed-text')) return text;
  return `${inputType === 'query' ? 'search_query' : 'search_document'}: ${text}`;
}

class OllamaEmbeddingProvider {
  constructor({ url = 'http://localhost:11434', model = 'nomic-embed-text', timeoutMs = 120000, fetchImpl = globalThis.fetch } = {}) {
    this.name = 'ollama';
    this.url = url.replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.semantic = true;
    this.minVector = 0.5; // TODO: calibrate on real nomic vectors (unrelated short texts often score 0.3-0.5)
    this.key = `${this.url} ${model}`;
    this.dims = learned.get(this.key) || KNOWN_DIMS[model.split(':')[0]] || null;
  }

  // Includes the size, so vectors of different sizes are never compared and a size change forces a backfill
  get id() {
    return `ollama:${this.model}:${this.dims || 'unknown'}`;
  }

  // Makes sure dims (and so id) come from the server: one tiny call the first time, nothing after that
  async ready() {
    if (!learned.has(this.key)) await this.embed(['dimension check']);
    return this;
  }

  async embed(texts, { inputType = 'document' } = {}) {
    if (texts.length > MAX_BATCH) {
      const out = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH) out.push(...(await this.embed(texts.slice(i, i + MAX_BATCH), { inputType })));
      return out;
    }
    const payload = { model: this.model, input: texts.map((t) => withPrefix(this.model, String(t), inputType)), truncate: true };
    const body = await ollamaPost({ url: this.url, path: '/api/embed', payload, timeoutMs: this.timeoutMs, fetchImpl: this.fetch });
    if (!body || !Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) throw new Error('Ollama: unexpected /api/embed response');
    const size = body.embeddings[0] ? body.embeddings[0].length : 0;
    if (!size || body.embeddings.some((v) => v.length !== size)) throw new Error('Ollama: vectors of different sizes in one answer');
    this.dims = size;
    learned.set(this.key, size);
    return body.embeddings;
  }
}

module.exports = { OllamaEmbeddingProvider, KNOWN_DIMS, MAX_BATCH, withPrefix, learned };
