// Voyage AI embeddings over HTTPS (a real SEMANTIC model). Used only when EMBEDDING_PROVIDER=voyage and
// VOYAGE_API_KEY is set. Costs money per token, so it was NOT run during development: the request shape is
// covered by a test with a fake fetch, never by a network call.
//
// API used (TODO: verify against https://docs.voyageai.com before the first paid run):
//   POST https://api.voyageai.com/v1/embeddings
//   { input: [texts], model, input_type: "document" | "query", output_dimension }
//   -> { data: [{ index, embedding }], usage: { total_tokens } }
// input_type matters: Voyage embeds questions and stored documents slightly differently for better retrieval.
const URL = 'https://api.voyageai.com/v1/embeddings';
const MAX_BATCH = 128; // texts per request; the backfill sends batches no larger than this

class VoyageEmbeddingProvider {
  constructor({ apiKey = process.env.VOYAGE_API_KEY, model = 'voyage-3.5', dims = 1024, fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) throw new Error('EMBEDDING_PROVIDER=voyage needs VOYAGE_API_KEY');
    this.name = 'voyage';
    this.model = model;
    this.dims = dims;
    this.id = `voyage:${model}:${dims}`;
    this.semantic = true;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.lastUsage = null; // total_tokens of the last call, for cost checks
  }

  async embed(texts, { inputType = 'document' } = {}) {
    if (texts.length > MAX_BATCH) throw new Error(`Voyage: at most ${MAX_BATCH} texts per call`);
    const response = await this.fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ input: texts, model: this.model, input_type: inputType, output_dimension: this.dims }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Voyage API error ${response.status}: ${detail.slice(0, 200)}`);
    }
    const body = await response.json();
    if (!body || !Array.isArray(body.data) || body.data.length !== texts.length) throw new Error('Voyage: unexpected response shape');
    this.lastUsage = body.usage || null;
    // The API returns one item per input with its index; sort so vectors line up with the texts
    return [...body.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }
}

module.exports = { VoyageEmbeddingProvider, URL, MAX_BATCH };
