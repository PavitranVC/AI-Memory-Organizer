const { connect, disconnect, clear, api, createUser, createCategory, models } = require('./helpers');
const memoryService = require('../services/memoryService');
const llm = require('../services/llm');
const { MockProvider } = require('../services/llm/mockProvider');
const { validateAnswer } = require('../services/llm/schemas');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);
afterEach(() => {
  llm.setProvider(null);
  jest.restoreAllMocks();
});

async function setup() {
  const { user, token } = await createUser();
  await createCategory('Personal');
  await createCategory('Hobbies');
  // Pune from 2020; moved to Mumbai in March 2024 (SUPERSEDE)
  const pune = await memoryService.createMemory(user._id, { content: 'Lives in Pune', category: 'Personal', validFrom: '2020-01-01', tags: ['home city'] });
  const mumbai = await memoryService.updateMemory(user._id, pune._id, { content: 'Lives in Mumbai', validFrom: '2024-03-01' });
  return { user, token, pune, mumbai };
}

// Records what the answer model was sent, and answers like the mock
function recordingProvider(seen, answer) {
  const mock = new MockProvider();
  return {
    name: 'mock',
    generateJson: async (args) => {
      seen.push(args);
      return answer ? { data: answer, usage: {}, stopReason: 'end_turn', servedModel: args.model } : mock.generateJson(args);
    },
  };
}

describe('POST /api/ask', () => {
  test('answers from the current memory and cites it; the call is logged', async () => {
    const { token, mumbai } = await setup();
    const res = await api(token).post('/api/ask').send({ question: 'Where do I live?' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ question: 'Where do I live?', insufficient: false, llmCalled: true, embeddingModel: 'mock-hash-64' });
    expect(res.body.answer).toMatch(/Mumbai/);
    expect(res.body.citedMemoryIds).toEqual([String(mumbai._id)]);
    expect(res.body.citations).toEqual([expect.objectContaining({ label: 'm1', id: String(mumbai._id), content: 'Lives in Mumbai', validTo: null })]);
    expect(res.body.memories.map((m) => m.content)).toEqual(['Lives in Mumbai']);
    expect(res.body.memories[0].components).toBeDefined();
    const call = await models.LlmCall.findOne({ task: 'answer' }).lean();
    expect(call).toMatchObject({ provider: 'mock', promptId: 'answer.v1', status: 'ok' });
  });

  test('asOf answers about the past: in 2022 the user lived in Pune', async () => {
    const { token, pune } = await setup();
    const seen = [];
    llm.setProvider(recordingProvider(seen));
    const res = await api(token).post('/api/ask').send({ question: 'Where do I live?', asOf: '2022-06-01' });
    expect(res.status).toBe(200);
    expect(res.body.answer).toMatch(/Pune/);
    expect(res.body.citedMemoryIds).toEqual([String(pune._id)]);
    expect(res.body.asOf).toBe('2022-06-01T00:00:00.000Z');
    // The model is told the question date; Pune was still true then, so it is shown as open (validTo null)
    expect(seen[0].user).toMatch(/QUESTION DATE[^\n]*\n2022-06-01/);
    expect(seen[0].vars.memories).toEqual([{ label: 'm1', content: 'Lives in Pune', category: 'Personal', validFrom: '2020-01-01', validTo: null, importance: 3 }]);
    // Database ids never reach the model: only labels
    expect(seen[0].user).not.toContain(String(pune._id));
  });

  test('no relevant memory: says so without calling the model', async () => {
    const { token } = await setup();
    const res = await api(token).post('/api/ask').send({ question: 'What is my favourite chess opening?' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ insufficient: true, llmCalled: false, citedMemoryIds: [], memories: [] });
    expect(await models.LlmCall.countDocuments({ task: 'answer' })).toBe(0);
    // Before anything was known, there is nothing to say either
    expect((await api(token).post('/api/ask').send({ question: 'Where do I live?', asOf: '2019-01-01' })).body.llmCalled).toBe(false);
  });

  test('only the top-k memories are sent to the model (k from the request, capped at 20)', async () => {
    const { user, token } = await setup();
    for (let i = 0; i < 8; i += 1) await memoryService.createMemory(user._id, { content: `Plays chess opening ${i}`, category: 'Hobbies' });
    const seen = [];
    llm.setProvider(recordingProvider(seen));
    const res = await api(token).post('/api/ask').send({ question: 'Which chess openings do I play?', k: 3 });
    expect(res.status).toBe(200);
    expect(res.body.memories).toHaveLength(3);
    expect(seen[0].vars.memories.map((m) => m.label)).toEqual(['m1', 'm2', 'm3']);
    expect((await api(token).post('/api/ask').send({ question: 'chess', k: 21 })).status).toBe(400);
  });

  test("another user's memories are never retrieved or cited", async () => {
    const { token } = await setup();
    const other = await createUser();
    const res = await api(other.token).post('/api/ask').send({ question: 'Where do I live?' });
    expect(res.body).toMatchObject({ insufficient: true, memories: [] });
    expect((await api(token).post('/api/ask').send({ question: 'Where do I live?' })).body.memories).toHaveLength(1);
  });

  test('bad input is a 400; no token is a 401', async () => {
    const { token } = await setup();
    expect((await api(token).post('/api/ask').send({})).status).toBe(400);
    expect((await api(token).post('/api/ask').send({ question: '   ' })).status).toBe(400);
    expect((await api(token).post('/api/ask').send({ question: 'x'.repeat(1001) })).status).toBe(400);
    expect((await api(token).post('/api/ask').send({ question: 'Where?', asOf: 'yesterday' })).status).toBe(400);
    expect((await api(token).post('/api/ask').send({ question: 'Where?', asOf: 2022 })).status).toBe(400);
    expect((await api(null).post('/api/ask').send({ question: 'Where do I live?' })).status).toBe(401);
  });

  test('a citation the model was not shown is rejected (502), as is a failing model', async () => {
    const { token } = await setup();
    llm.setProvider(recordingProvider([], { answer: 'You live in Delhi.', citedMemories: ['m9'], insufficient: false }));
    const res = await api(token).post('/api/ask').send({ question: 'Where do I live?' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/m9/);
    llm.setProvider(null);
    const failed = await api(token).post('/api/ask').send({ question: 'Where do I live? [mock:fail]' });
    expect(failed.status).toBe(502);
    expect(await models.LlmCall.countDocuments({ task: 'answer', status: 'error' })).toBe(1);
  });
});

describe('validateAnswer', () => {
  test('keeps known labels once, rejects unknown ones and malformed answers', () => {
    expect(validateAnswer({ answer: ' Yes. ', citedMemories: ['m1', 'm1', 'm2'], insufficient: false }, ['m1', 'm2'])).toEqual({ answer: 'Yes.', citedMemories: ['m1', 'm2'], insufficient: false });
    expect(() => validateAnswer({ answer: 'x', citedMemories: ['m3'] }, ['m1'])).toThrow(/m3/);
    expect(() => validateAnswer({ answer: '', citedMemories: [] }, [])).toThrow(/answer/);
    expect(() => validateAnswer({ answer: 'x' }, [])).toThrow(/citedMemories/);
  });
});
