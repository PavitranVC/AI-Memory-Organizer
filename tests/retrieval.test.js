const { connect, disconnect, clear, api, createUser, createCategory, models } = require('./helpers');
const memoryService = require('../services/memoryService');
const embeddings = require('../services/embeddings');
const { normalize } = require('../services/embeddings/hashing');
const { retrieve } = require('../services/retrieval');
const { retrievalConfig, DEFAULT_WEIGHTS } = require('../services/retrieval/config');
const vectorStore = require('../services/retrieval/vectorStore');
const retrieval = require('../services/retrieval');
const extraction = require('../services/extractionService');
const { emulateAtlas, index } = require('./fixtures/atlasEmulator');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);
afterEach(() => {
  embeddings.setEmbedder(null);
  vectorStore.setAtlasAggregate(undefined);
  jest.restoreAllMocks();
});

const TEXT_ONLY = { text: 1, vector: 0, recency: 0, importance: 0 };
const contents = (out) => out.results.map((r) => r.memory.content);

async function setup() {
  const { user, token } = await createUser();
  await Promise.all(['Personal', 'Hobbies', 'Health'].map((name) => createCategory(name)));
  const add = (content, extra = {}) => memoryService.createMemory(user._id, { content, category: 'Personal', ...extra });
  return { user, token, add };
}

// Pune from 2020, then the user moved to Mumbai in March 2024 (a SUPERSEDE: Pune's validTo = 2024-03-01)
async function moved(user, add) {
  const pune = await add('Lives in Pune', { validFrom: '2020-01-01', tags: ['home city'] });
  const mumbai = await memoryService.updateMemory(user._id, pune._id, { content: 'Lives in Mumbai', validFrom: '2024-03-01' });
  return { pune, mumbai };
}

describe('configuration', () => {
  test('defaults, weights from the environment, and bad values rejected', () => {
    const config = retrievalConfig({});
    expect(config).toMatchObject({ backend: 'local', topK: 5, candidates: 50, halfLifeDays: 90, minVector: null, weights: DEFAULT_WEIGHTS });
    expect(retrievalConfig({ RETRIEVAL_W_TEXT: '0', RETRIEVAL_W_VECTOR: '1' }).weights).toEqual({ ...DEFAULT_WEIGHTS, text: 0, vector: 1 });
    expect(() => retrievalConfig({ VECTOR_BACKEND: 'faiss' })).toThrow(/VECTOR_BACKEND/);
    expect(() => retrievalConfig({ RETRIEVAL_TOP_K: '50' })).toThrow(/RETRIEVAL_TOP_K/);
    expect(() => retrievalConfig({ RETRIEVAL_W_TEXT: '-1' })).toThrow(/RETRIEVAL_W_TEXT/);
    expect(() => retrievalConfig({ RETRIEVAL_W_TEXT: '0', RETRIEVAL_W_VECTOR: '0', RETRIEVAL_W_RECENCY: '0', RETRIEVAL_W_IMPORTANCE: '0' })).toThrow(/at least one/);
  });
});

describe('ranking order', () => {
  test('only memories about the question are returned, best match first, with the four score parts', async () => {
    const { user, add } = await setup();
    await add('Plays chess every weekend', { category: 'Hobbies' });
    await add('Plays chess', { category: 'Hobbies' });
    await add('Lives in Pune', { importance: 5 }); // important and recent, but not about chess
    const out = await retrieve(user._id, { query: 'chess' });
    expect(contents(out)).toEqual(['Plays chess', 'Plays chess every weekend']);
    for (const r of out.results) {
      expect(Object.keys(r.components)).toEqual(['text', 'vector', 'recency', 'importance']);
      expect(r.components.text).toBeGreaterThan(0);
      expect(r.components.vector).toBeGreaterThan(0);
      expect(r.memory.embedding).toBeUndefined();
    }
    expect(out.results[0].score).toBeGreaterThanOrEqual(out.results[1].score);
  });

  test('importance decides between equally relevant memories, recency between equally important ones', async () => {
    const { user, add } = await setup();
    await add('Plays chess', { importance: 2, validFrom: '2025-01-01' });
    await add('Plays chess', { importance: 5, validFrom: '2020-01-01' });
    let out = await retrieve(user._id, { query: 'chess', weights: { text: 0.4, vector: 0.4, recency: 0, importance: 0.2 } });
    expect(out.results.map((r) => r.memory.importance)).toEqual([5, 2]);
    out = await retrieve(user._id, { query: 'chess', weights: { text: 0.4, vector: 0.4, recency: 0.2, importance: 0 } });
    expect(out.results.map((r) => r.memory.importance)).toEqual([2, 5]); // the 2025 fact is more recent
    // Recency halves every 90 days: a 5-year-old fact scores close to 0
    expect(out.results[1].components.recency).toBeLessThan(0.01);
  });

  test('the score is exactly the weighted sum of its parts', async () => {
    const { user, add } = await setup();
    await add('Plays chess', { importance: 4 });
    const w = { text: 0.1, vector: 0.2, recency: 0.3, importance: 0.4 };
    const [r] = (await retrieve(user._id, { query: 'chess', weights: w })).results;
    const expected = w.text * r.components.text + w.vector * r.components.vector + w.recency * r.components.recency + w.importance * r.components.importance;
    expect(r.score).toBeCloseTo(expected, 3);
    expect(r.components.importance).toBe(0.75);
  });

  test('a match by vector alone (no shared keyword) is found: what a semantic embedder adds', async () => {
    const { user, add } = await setup();
    // A fake "semantic" embedder that knows flat = apartment (the mock and the lexical embedder do not)
    const topic = (text) => (/flat|apartment/i.test(text) ? [1, 0, 0] : /chess/i.test(text) ? [0, 1, 0] : [0, 0, 1]);
    embeddings.setEmbedder({ name: 'fake', id: 'fake-3', dims: 3, embed: async (texts) => texts.map((t) => normalize(topic(t))) });
    await add('Rents an apartment near the station');
    await add('Plays chess');
    const out = await retrieve(user._id, { query: 'my flat' });
    expect(contents(out)).toEqual(['Rents an apartment near the station']);
    expect(out.results[0].components).toMatchObject({ text: 0, vector: 1 });
    // With keywords only, the same question finds nothing
    expect((await retrieve(user._id, { query: 'my flat', weights: TEXT_ONLY })).results.filter((r) => r.components.text > 0)).toHaveLength(0);
  });

  test('k caps the number of results; the candidate lists are larger', async () => {
    const { user, add } = await setup();
    for (let i = 0; i < 8; i += 1) await add(`Plays chess opening ${i}`);
    expect((await retrieve(user._id, { query: 'chess', k: 3 })).results).toHaveLength(3);
    expect((await retrieve(user._id, { query: 'chess' })).results).toHaveLength(5); // RETRIEVAL_TOP_K default
    await expect(retrieve(user._id, { query: 'chess', k: 21 })).rejects.toMatchObject({ status: 400 });
    await expect(retrieve(user._id, { query: '  ' })).rejects.toMatchObject({ status: 400 });
  });

  test('if the query cannot be embedded, keyword search still answers and a warning says so', async () => {
    const { user, add } = await setup();
    await add('Plays chess');
    const out = await retrieve(user._id, { query: 'chess [mock:embed-fail]' });
    expect(contents(out)).toEqual(['Plays chess']);
    expect(out.warnings[0]).toMatch(/Vector search skipped/);
    expect(out.results[0].components.vector).toBe(0);
  });
});

describe('asOf: only facts valid at the query time', () => {
  test('"Where do I live?" now, in 2022 and before anything was known', async () => {
    const { user, add } = await setup();
    await moved(user, add);
    expect(contents(await retrieve(user._id, { query: 'Where do I live?' }))).toEqual(['Lives in Mumbai']);
    expect(contents(await retrieve(user._id, { query: 'Where do I live?', asOf: '2022-06-01' }))).toEqual(['Lives in Pune']);
    expect(contents(await retrieve(user._id, { query: 'Where do I live?', asOf: new Date('2024-03-01T00:00:00Z') }))).toEqual(['Lives in Mumbai']);
    expect(contents(await retrieve(user._id, { query: 'Where do I live?', asOf: '2019-01-01' }))).toEqual([]);
    await expect(retrieve(user._id, { query: 'live', asOf: 'last year' })).rejects.toMatchObject({ status: 400 });
  });

  test('retracted (deleted) memories are never retrieved', async () => {
    const { user, add } = await setup();
    const m = await add('Plays chess', { validFrom: '2020-01-01' });
    await memoryService.deleteMemory(user._id, m._id);
    expect((await retrieve(user._id, { query: 'chess' })).results).toEqual([]);
    expect((await retrieve(user._id, { query: 'chess', asOf: '2021-01-01' })).results).toEqual([]);
  });

  test('recency is measured from the query time, not from today', async () => {
    const { user, add } = await setup();
    await add('Plays chess', { validFrom: '2021-01-01' });
    const [r] = (await retrieve(user._id, { query: 'chess', asOf: '2021-01-01' })).results;
    expect(r.components.recency).toBe(1);
  });
});

describe('scoping and usage', () => {
  test("another user's memories are never retrieved", async () => {
    const { user, add } = await setup();
    const other = await createUser();
    await memoryService.createMemory(other.user._id, { content: 'Lives in Delhi', category: 'Personal' });
    await add('Lives in Pune');
    expect(contents(await retrieve(user._id, { query: 'Where do I live?' }))).toEqual(['Lives in Pune']);
    expect(contents(await retrieve(other.user._id, { query: 'Where do I live?' }))).toEqual(['Lives in Delhi']);
  });

  test('returned memories count as accessed (in place, no new version); touch: false leaves them alone', async () => {
    const { user, add } = await setup();
    const m = await add('Plays chess');
    await add('Lives in Pune');
    const out = await retrieve(user._id, { query: 'chess' });
    expect(out.results[0].memory.accessCount).toBe(1);
    let stored = await models.Memory.findById(m._id).lean();
    expect(stored.accessCount).toBe(1);
    expect(stored.lastAccessedAt).not.toBeNull();
    expect(stored.updatedAt.getTime()).toBe(m.updatedAt.getTime());
    expect(await models.Memory.countDocuments()).toBe(2);
    await retrieve(user._id, { query: 'chess', touch: false });
    stored = await models.Memory.findById(m._id).lean();
    expect(stored.accessCount).toBe(1);
    expect((await models.Memory.findOne({ content: 'Lives in Pune' }).lean()).accessCount).toBe(0);
  });

  test('GET /api/memories/retrieve: scores and parts, no vectors, errors as 400', async () => {
    const { token, user, add } = await setup();
    await moved(user, add);
    const res = await api(token).get('/api/memories/retrieve?q=Where%20do%20I%20live&asOf=2022-01-01&k=2');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ k: 2, backend: 'local', embeddingModel: 'mock-hash-64' });
    expect(res.body.results.map((r) => r.memory.content)).toEqual(['Lives in Pune']);
    expect(res.body.results[0].memory.embedding).toBeUndefined();
    expect(res.body.results[0].memory.categoryId.name).toBe('Personal');
    expect((await api(token).get('/api/memories/retrieve')).status).toBe(400);
    expect((await api(token).get('/api/memories/retrieve?q=x&k=0')).status).toBe(400);
    expect((await api(null).get('/api/memories/retrieve?q=x')).status).toBe(401);
  });
});

describe('local and Atlas backends give the same answer (Atlas emulated)', () => {
  async function corpus() {
    const { user, add } = await setup();
    await moved(user, add);
    await add('Plays chess on weekends', { category: 'Hobbies', validFrom: '2021-05-01' });
    await add('Is learning chess openings', { category: 'Hobbies', validFrom: '2023-02-01' });
    await add('Is allergic to peanuts', { category: 'Health', validFrom: '2019-01-01' });
    const gone = await add('Lives with a cat named Chess', { validFrom: '2022-01-01' });
    await memoryService.deleteMemory(user._id, gone._id);
    const other = await createUser();
    await memoryService.createMemory(other.user._id, { content: 'Plays chess daily', category: 'Hobbies' });
    return user;
  }

  test('the committed index declares the vector field and every field the pipeline pre-filters on', () => {
    expect(index).toMatchObject({ name: 'memory_vector_index', type: 'vectorSearch', collection: 'memories' });
    const vector = index.definition.fields.find((f) => f.type === 'vector');
    expect(vector).toMatchObject({ path: 'embedding', similarity: 'cosine' });
    const pipeline = vectorStore.atlasPipeline({ userId: 'u', temporal: {}, at: new Date(), queryVector: [1], model: 'm', limit: 10, indexName: index.name });
    const declared = index.definition.fields.filter((f) => f.type === 'filter').map((f) => f.path).sort();
    const used = pipeline[0].$vectorSearch.filter.$and.map((clause) => Object.keys(clause)[0]).sort();
    expect(used).toEqual(declared);
    expect(pipeline[0].$vectorSearch).toMatchObject({ limit: 40, numCandidates: 400 });
  });

  test.each([
    ['chess', undefined],
    ['Where do I live?', undefined],
    ['Where do I live?', '2022-06-01'],
    ['chess', '2022-01-01'],
    ['peanuts allergy', '2018-01-01'],
  ])('vector search for "%s" (asOf %s)', async (query, asOf) => {
    const user = await corpus();
    vectorStore.setAtlasAggregate(emulateAtlas);
    const { filter: temporal, asOf: at } = memoryService.temporalFilter(asOf ? { asOf } : {});
    const { vector, model } = await embeddings.embedQuery(query);
    const args = { userId: user._id, temporal, at: at || new Date(), queryVector: vector, model, limit: 3, indexName: index.name };
    const local = await vectorStore.search('local', args);
    const atlas = await vectorStore.search('atlas', args);
    expect(atlas.map((h) => String(h._id))).toEqual(local.map((h) => String(h._id)));
    atlas.forEach((h, i) => expect(h.vectorScore).toBeCloseTo(local[i].vectorScore, 10));

    // And the whole hybrid ranking is identical with either backend
    const config = retrievalConfig({});
    const viaLocal = await retrieve(user._id, { query, asOf, touch: false, config });
    const viaAtlas = await retrieve(user._id, { query, asOf, touch: false, config: { ...config, backend: 'atlas' } });
    expect(viaAtlas.results).toEqual(viaLocal.results);
    expect(viaAtlas.backend).toBe('atlas');
  });
});

describe('reconciliation uses hybrid retrieval (Stage 3 -> 4)', () => {
  test('findSimilar asks the retrieval service for text + vector matches, without counting an access', async () => {
    const { user, add } = await setup();
    await add('Lives in Pune', { tags: ['home city'] });
    const spy = jest.spyOn(retrieval, 'retrieve');
    const similar = await extraction.findSimilar(user._id, { content: 'Lives in Mumbai', topic: 'home city' });
    expect(similar.map((m) => m.content)).toEqual(['Lives in Pune']);
    expect(similar[0].categoryId.name).toBe('Personal');
    expect(spy).toHaveBeenCalledWith(user._id, expect.objectContaining({ touch: false, weights: { text: 0.5, vector: 0.5, recency: 0, importance: 0 } }));
    expect((await models.Memory.findOne({ content: 'Lives in Pune' }).lean()).accessCount).toBe(0);
  });
});

describe('relevance cut-off for vector-only matches', () => {
  test("the embedder's own cut-off applies unless RETRIEVAL_MIN_VECTOR is set", async () => {
    const { user, add } = await setup();
    // A fake embedder: the question and the memory have cosine 0.6, and no shared keyword
    const vec = (t) => (/question/i.test(t) ? [1, 0] : [0.6, 0.8]);
    embeddings.setEmbedder({ name: 'fake', id: 'fake-2', dims: 2, minVector: 0.7, embed: async (texts) => texts.map(vec) });
    await add('Rents an apartment');
    expect((await retrieve(user._id, { query: 'question' })).results).toHaveLength(0); // 0.6 < 0.7
    const config = { ...retrievalConfig({}), minVector: 0.5 };
    expect((await retrieve(user._id, { query: 'question', config })).results).toHaveLength(1);
    expect(new (require('../services/embeddings/lexicalProvider').LexicalEmbeddingProvider)().minVector).toBe(0.3);
  });
});
