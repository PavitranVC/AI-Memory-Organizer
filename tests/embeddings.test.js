const { connect, disconnect, clear, api, createUser, createCategory, models } = require('./helpers');
const embeddings = require('../services/embeddings');
const { MockEmbeddingProvider } = require('../services/embeddings/mockProvider');
const { LexicalEmbeddingProvider } = require('../services/embeddings/lexicalProvider');
const { VoyageEmbeddingProvider } = require('../services/embeddings/voyageProvider');
const { embeddingConfig } = require('../services/embeddings/config');
const { cosine, tokenize } = require('../services/embeddings/hashing');
const { backfillEmbeddings } = require('../services/embeddings/backfill');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);
afterEach(() => {
  embeddings.setEmbedder(null);
  jest.restoreAllMocks();
});

const length = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe('providers', () => {
  test('config: lexical by default (offline), mock in tests, unknown providers rejected', () => {
    expect(embeddingConfig({}).provider).toBe('lexical');
    expect(embeddingConfig({ EMBEDDING_PROVIDER: 'MOCK' }).provider).toBe('mock');
    expect(embeddingConfig({ EMBEDDING_PROVIDER: 'voyage' }).voyage).toEqual({ model: 'voyage-3.5', dims: 1024 });
    expect(() => embeddingConfig({ EMBEDDING_PROVIDER: 'openai' })).toThrow(/EMBEDDING_PROVIDER/);
    expect(() => embeddingConfig({ VOYAGE_DIMENSIONS: '0' })).toThrow(/VOYAGE_DIMENSIONS/);
    expect(embeddings.getEmbedder().name).toBe('mock'); // tests/setupEnv.js
  });

  test('tokenizer drops stop words and strips simple suffixes', () => {
    expect(tokenize('Where do I live?')).toEqual(['live']);
    expect(tokenize('Lives in Mumbai')).toEqual(['live', 'mumbai']);
  });

  test('mock: deterministic unit vectors; shared words give a higher cosine; failure hook', async () => {
    const mock = new MockEmbeddingProvider();
    const [a, b, c] = await mock.embed(['Lives in Mumbai', 'Where do I live?', 'Plays chess']);
    expect(a).toHaveLength(64);
    expect(length(a)).toBeCloseTo(1, 10);
    expect(await mock.embed(['Lives in Mumbai'])).toEqual([a]);
    expect(cosine(a, b)).toBeGreaterThan(cosine(c, b));
    await expect(mock.embed(['x [mock:embed-fail]'])).rejects.toThrow(/simulated/);
  });

  test('lexical: a deterministic 256-d LEXICAL baseline, labelled as not semantic', async () => {
    const lexical = new LexicalEmbeddingProvider();
    expect(lexical).toMatchObject({ name: 'lexical', id: 'lexical-hash-v1-256', dims: 256, semantic: false });
    const [home, question, chess, flat, apartment] = await lexical.embed(['Lives in Mumbai', 'Where do I live?', 'Plays chess on weekends', 'flat', 'apartment']);
    expect(length(home)).toBeCloseTo(1, 10);
    expect(await lexical.embed(['Lives in Mumbai'])).toEqual([home]);
    expect(cosine(home, question)).toBeGreaterThan(0.3);
    expect(cosine(home, question)).toBeGreaterThan(cosine(chess, question));
    // The known limitation: synonyms with no shared letters are unrelated to a lexical embedder
    expect(Math.abs(cosine(flat, apartment))).toBeLessThan(0.3);
    // Word pieces still overlap: a spelling variant is closer than an unrelated word
    const [colour, color] = await lexical.embed(['colour', 'color']);
    expect(cosine(colour, color)).toBeGreaterThan(cosine(colour, chess));
  });

  test('voyage: needs a key; sends the documented request; never calls the network in tests', async () => {
    expect(() => new VoyageEmbeddingProvider({ apiKey: '' })).toThrow(/VOYAGE_API_KEY/);
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { total_tokens: 7 } }) };
    };
    const voyage = new VoyageEmbeddingProvider({ apiKey: 'test-key', model: 'voyage-3.5', dims: 2, fetchImpl });
    expect(voyage.id).toBe('voyage:voyage-3.5:2');
    expect(await voyage.embed(['a', 'b'], { inputType: 'query' })).toEqual([[1, 0], [0, 1]]); // sorted by index
    expect(calls[0].url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(calls[0].init.body)).toEqual({ input: ['a', 'b'], model: 'voyage-3.5', input_type: 'query', output_dimension: 2 });
    expect(voyage.lastUsage).toEqual({ total_tokens: 7 });

    const failing = new VoyageEmbeddingProvider({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad key' }) });
    await expect(failing.embed(['a'])).rejects.toThrow(/401/);
  });

  test('vectors of the wrong size are rejected before they reach the database', async () => {
    const broken = { name: 'broken', id: 'broken-3', dims: 3, embed: async (texts) => texts.map(() => [1, 0]) };
    await expect(embeddings.embedDocuments(['a'], broken)).rejects.toThrow(/3 finite numbers/);
  });
});

describe('a vector on every memory version', () => {
  async function setup() {
    const { user, token } = await createUser();
    await createCategory('Personal');
    return { user, token };
  }

  test('create stores the vector and its model, but never returns it or puts it in the audit log', async () => {
    const { token } = await setup();
    const res = await api(token).post('/api/memories').send({ content: 'Lives in Pune', category: 'Personal', tags: ['home city'] });
    expect(res.status).toBe(201);
    expect(res.body.embedding).toBeUndefined();
    expect(res.body.embeddingModel).toBe('mock-hash-64');
    const stored = await models.Memory.findById(res.body._id).select('+embedding').lean();
    expect(stored.embedding).toEqual((await embeddings.embedDocuments(['Lives in Pune home city'])).vectors[0]);
    expect((await api(token).get(`/api/memories/${res.body._id}`)).body.embedding).toBeUndefined();
    expect((await api(token).get('/api/memories')).body.memories[0].embedding).toBeUndefined();
    const entry = await models.AuditLog.findOne({ memoryId: res.body._id }).lean();
    expect(entry.after.embedding).toBeUndefined();
  });

  test('a new version with new text gets a new vector; same text reuses the old one without a call', async () => {
    const { token } = await setup();
    const created = (await api(token).post('/api/memories').send({ content: 'Lives in Pune', category: 'Personal', validFrom: '2020-01-01' })).body;
    const moved = (await api(token).put(`/api/memories/${created._id}`).send({ content: 'Lives in Mumbai', validFrom: '2024-03-01' })).body;
    const [v1, v2] = await Promise.all([created._id, moved._id].map((id) => models.Memory.findById(id).select('+embedding').lean()));
    expect(v2.embedding).not.toEqual(v1.embedding);

    const spy = jest.spyOn(MockEmbeddingProvider.prototype, 'embed');
    const reweighted = (await api(token).put(`/api/memories/${moved._id}`).send({ importance: 5, validFrom: '2024-04-01' })).body;
    const v3 = await models.Memory.findById(reweighted._id).select('+embedding').lean();
    expect(v3.embedding).toEqual(v2.embedding);
    expect(v3.embeddingModel).toBe('mock-hash-64');
    expect(spy).not.toHaveBeenCalled();
  });

  test('if the embedding provider fails, the memory is still saved (without a vector) and the backfill fixes it', async () => {
    const { token } = await setup();
    const res = await api(token).post('/api/memories').send({ content: 'Likes tea [mock:embed-fail]', category: 'Personal' });
    expect(res.status).toBe(201);
    expect(res.body.embeddingModel).toBeNull();
    // The backfill uses a provider that works (here: the lexical one)
    const summary = await backfillEmbeddings({ provider: new LexicalEmbeddingProvider() });
    expect(summary).toMatchObject({ model: 'lexical-hash-v1-256', embedded: 1, total: 1 });
    const stored = await models.Memory.findById(res.body._id).select('+embedding').lean();
    expect(stored.embedding).toHaveLength(256);
  });
});

describe('backfill', () => {
  test('embeds believed versions only, in batches, without touching updatedAt; re-running does nothing', async () => {
    const { user } = await createUser();
    const category = await createCategory('Hobbies');
    const old = new Date('2024-01-01T00:00:00Z');
    const rows = Array.from({ length: 7 }, (_, i) => ({ userId: user._id, categoryId: category._id, content: `Hobby number ${i}`, updatedAt: old, createdAt: old }));
    rows.push({ userId: user._id, categoryId: category._id, content: 'Deleted', retractedAt: new Date() });
    await models.Memory.collection.insertMany(rows.map((r) => ({ validFrom: old, recordedAt: old, validTo: null, retractedAt: null, ...r })));

    const progress = [];
    const first = await backfillEmbeddings({ batchSize: 3, onProgress: (p) => progress.push(p.embedded) });
    expect(first).toMatchObject({ model: 'mock-hash-64', dims: 64, embedded: 7, total: 7 });
    expect(progress).toEqual([3, 6, 7]);
    const stored = await models.Memory.find({ retractedAt: null }).select('+embedding').lean();
    expect(stored.every((m) => m.embedding.length === 64 && m.embeddingModel === 'mock-hash-64')).toBe(true);
    expect(stored.every((m) => m.updatedAt.getTime() === old.getTime())).toBe(true);
    expect(await models.Memory.findOne({ content: 'Deleted' }).select('+embedding').lean()).not.toHaveProperty('embedding');

    expect((await backfillEmbeddings()).embedded).toBe(0);
    // Switching model re-embeds everything, so two models are never mixed in one search
    expect((await backfillEmbeddings({ provider: new LexicalEmbeddingProvider() })).embedded).toBe(7);
  });
});
