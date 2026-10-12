const { fnv1a, tokenize, normalize } = require('./hashing');

// A deterministic stand-in for an embedding model, used by every test (EMBEDDING_PROVIDER=mock), so CI never
// needs a key or a network. Each stemmed word adds 1 to one of 64 hashed buckets. It is a TEST DOUBLE: it
// exists so tests can predict which memories are "similar". Its output is never a result.
//
// Test hook: a text containing "[mock:embed-fail]" makes the call fail, to test what happens when the
// embedding service is down.
const DIMS = 64;

class MockEmbeddingProvider {
  constructor() {
    this.name = 'mock';
    this.dims = DIMS;
    this.id = `mock-hash-${DIMS}`; // stored on each memory as embeddingModel
    this.minVector = 0.1; // see LexicalEmbeddingProvider
  }

  async embed(texts) {
    if (texts.some((t) => String(t).includes('[mock:embed-fail]'))) throw new Error('mock: simulated embedding failure');
    return texts.map((text) => {
      const vector = new Array(DIMS).fill(0);
      for (const token of tokenize(text)) vector[fnv1a(token) % DIMS] += 1;
      return normalize(vector);
    });
  }
}

module.exports = { MockEmbeddingProvider, DIMS };
