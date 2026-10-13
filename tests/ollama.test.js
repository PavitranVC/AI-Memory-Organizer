// Stage 3b: the Ollama providers against a FAKE Ollama server (a local HTTP server that answers like Ollama).
// CI never runs Ollama and never downloads a model.
const http = require('http');
const { connect, disconnect, clear, createUser, createCategory, models } = require('./helpers');
const { llmConfig, OLLAMA_DEFAULTS } = require('../services/llm/config');
const { callLlmDetailed } = require('../services/llm');
const { OllamaProvider, stripThinking, parseJson, contextSize, listOllamaModels, hasModel } = require('../services/llm/ollamaProvider');
const { LlmError } = require('../services/llm/errors');
const { JUDGE_SCHEMA, EXTRACT_SCHEMA } = require('../services/llm/schemas');
const embeddings = require('../services/embeddings');
const { embeddingConfig } = require('../services/embeddings/config');
const { OllamaEmbeddingProvider, learned } = require('../services/embeddings/ollamaProvider');
const { backfillEmbeddings } = require('../services/embeddings/backfill');
const { timing } = require('../eval/report');

// The fake server: each request is answered by the next function in `replies` (or the last one, repeated).
// A reply returns { status, body, delayMs }. Every request is recorded with its parsed JSON body.
let server;
let url;
let replies = [];
let requests = [];
const chat = (content, extra = {}) => () => ({ body: { model: 'qwen2.5-coder:14b', message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 120, eval_count: 30, ...extra } });

beforeAll(async () => {
  await connect();
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, path: req.url, body });
      const reply = (replies.length > 1 ? replies.shift() : replies[0])({ path: req.url, body });
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(reply.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      }, reply.delayMs || 0);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await disconnect();
});

beforeEach(async () => {
  await clear();
  replies = [];
  requests = [];
  learned.clear();
});

afterEach(() => {
  process.env.LLM_PROVIDER = 'mock';
  for (const name of ['OLLAMA_URL', 'OLLAMA_MODEL', 'JUDGE_MODEL', 'OLLAMA_TIMEOUT_MS']) delete process.env[name];
  embeddings.setEmbedder(null);
});

const provider = (overrides = {}) => new OllamaProvider({ config: { url, numCtx: 8192, numCtxLarge: 32768, timeoutMs: 2000, ...overrides } });
const judgeArgs = { task: 'judge', model: 'deepseek-r1:14b', system: 'You are a judge.', user: 'Is it right?', schema: JUDGE_SCHEMA, maxTokens: 2000 };

describe('config', () => {
  test('LLM_PROVIDER=ollama: qwen2.5-coder:14b does the work and a DIFFERENT model (deepseek-r1:14b) judges', () => {
    const config = llmConfig({ LLM_PROVIDER: 'ollama' });
    expect(config.models).toEqual({ extract: 'qwen2.5-coder:14b', reconcile: 'qwen2.5-coder:14b', answer: 'qwen2.5-coder:14b', judge: 'deepseek-r1:14b' });
    expect(config.ollama).toEqual({ url: 'http://localhost:11434', numCtx: 8192, numCtxLarge: 32768, timeoutMs: OLLAMA_DEFAULTS.timeoutMs });
  });

  test('environment overrides; a large window smaller than the small one is rejected', () => {
    const config = llmConfig({ LLM_PROVIDER: 'ollama', OLLAMA_MODEL: 'llama3.1:8b', JUDGE_MODEL: 'qwen3:14b', OLLAMA_URL: 'http://gpu-box:11434/', OLLAMA_NUM_CTX: '4096' });
    expect(config.models.extract).toBe('llama3.1:8b');
    expect(config.models.judge).toBe('qwen3:14b');
    expect(config.ollama).toMatchObject({ url: 'http://gpu-box:11434', numCtx: 4096 });
    expect(() => llmConfig({ LLM_PROVIDER: 'ollama', OLLAMA_NUM_CTX: '9000', OLLAMA_NUM_CTX_LARGE: '8192' })).toThrow(/OLLAMA_NUM_CTX_LARGE/);
    expect(() => llmConfig({ LLM_PROVIDER: 'ollama', OLLAMA_TIMEOUT_MS: 'soon' })).toThrow(/OLLAMA_TIMEOUT_MS/);
  });

  test('EMBEDDING_PROVIDER=ollama defaults to nomic-embed-text, with no dimension setting', () => {
    expect(embeddingConfig({ EMBEDDING_PROVIDER: 'ollama' }).ollama).toEqual({ url: 'http://localhost:11434', model: 'nomic-embed-text', timeoutMs: 120000 });
  });
});

describe('parsing the answer', () => {
  test('a <think> block is removed before the JSON is parsed', () => {
    expect(parseJson('<think>The gold says Pune, the answer says Pune.</think>\n{"correct": true, "reason": "same city"}')).toEqual({ correct: true, reason: 'same city' });
    // Template opened <think> in the prompt: only the closing tag is in the answer
    expect(stripThinking('reasoning here</think>{"a":1}')).toBe('{"a":1}');
    expect(parseJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => parseJson('<think>never finished')).toThrow();
  });

  test('num_ctx: the small window when it fits, the large one only for a long prompt, an error beyond that', () => {
    const windows = { numCtx: 8192, numCtxLarge: 32768 };
    expect(contextSize(4000, 2048, windows)).toBe(8192);
    expect(contextSize(100000, 1024, windows)).toBe(32768); // a LoCoMo conversation in the full-context baseline
    expect(contextSize(200000, 1024, windows)).toBeNull();
  });
});

describe('chat provider (fake server)', () => {
  test('sends the schema as "format", a small num_ctx, temperature 0, and reads Ollama\'s token counts', async () => {
    replies = [chat('{"correct": true, "reason": "ok"}', { model: 'deepseek-r1:14b' })];
    const out = await provider().generateJson(judgeArgs);
    expect(out).toMatchObject({ data: { correct: true, reason: 'ok' }, servedModel: 'deepseek-r1:14b', stopReason: 'stop', attempts: 1 });
    expect(out.usage).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/api/chat');
    expect(requests[0].body).toEqual({
      model: 'deepseek-r1:14b',
      stream: false,
      format: JUDGE_SCHEMA,
      messages: [{ role: 'system', content: 'You are a judge.' }, { role: 'user', content: 'Is it right?' }],
      options: { num_ctx: 8192, num_predict: 2000, temperature: 0 },
    });
  });

  test('the full-context baseline gets the large window; the cached prefix is sent in the same user turn', async () => {
    replies = [chat('{"answer": "Pune", "citedMemories": [], "insufficient": false}')];
    await provider().generateJson({ task: 'eval_answer', model: 'qwen2.5-coder:14b', system: 'S', userPrefix: 'x'.repeat(100000), user: 'Q?', schema: {}, maxTokens: 4000 });
    expect(requests[0].body.options).toEqual({ num_ctx: 32768, num_predict: 1024, temperature: 0 });
    expect(requests[0].body.messages[1].content.endsWith('\n\nQ?')).toBe(true);
  });

  test('invalid JSON is retried once (not at temperature 0), and the tokens of both attempts are counted', async () => {
    replies = [chat('Sure! Here is the JSON:'), chat('<think>ok</think>{"correct": false, "reason": "different"}')];
    const out = await provider().generateJson(judgeArgs);
    expect(out.data).toEqual({ correct: false, reason: 'different' });
    expect(out.attempts).toBe(2);
    expect(out.usage.inputTokens).toBe(240);
    expect(requests.map((r) => r.body.options.temperature)).toEqual([0, 0.3]);
  });

  test('invalid JSON twice raises LlmError carrying the usage; a cut-off answer says so', async () => {
    replies = [chat('not json')];
    const err = await provider().generateJson(judgeArgs).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(/not valid JSON/);
    expect(err.result).toMatchObject({ attempts: 2, usage: { inputTokens: 240, outputTokens: 60 } });

    replies = [chat('{"correct": tr', { done_reason: 'length' })];
    const cut = await provider().generateJson(judgeArgs).catch((e) => e);
    expect(cut).toMatchObject({ stopReason: 'max_tokens', message: expect.stringMatching(/cut off/) });
  });

  test('a timeout is retried once', async () => {
    replies = [() => ({ delayMs: 400, body: {} }), chat('{"correct": true, "reason": "ok"}')];
    const out = await provider({ timeoutMs: 150 }).generateJson(judgeArgs);
    expect(out.attempts).toBe(2);
    expect(out.data.correct).toBe(true);

    replies = [() => ({ delayMs: 400, body: {} })];
    const err = await provider({ timeoutMs: 150 }).generateJson(judgeArgs).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(/did not answer within 150 ms/);
    expect(err.retryable).toBe(true);
  });

  test('a model that is not pulled fails at once (not retryable) and says how to fix it', async () => {
    replies = [() => ({ status: 404, body: { error: "model 'deepseek-r1:14b' not found" } })];
    const err = await provider().generateJson(judgeArgs).catch((e) => e);
    expect(err).toMatchObject({ retryable: false, message: expect.stringMatching(/ollama pull deepseek-r1:14b/) });
    expect(requests).toHaveLength(1);
  });

  test('Ollama not running: a retryable LlmError; a prompt too long for any window: refused before any call', async () => {
    const down = new OllamaProvider({ config: { url: 'http://127.0.0.1:1', numCtx: 8192, numCtxLarge: 32768, timeoutMs: 1000 } });
    const err = await down.generateJson(judgeArgs).catch((e) => e);
    expect(err).toMatchObject({ retryable: true, message: expect.stringMatching(/Cannot reach Ollama/) });

    const tooLong = await provider().generateJson({ ...judgeArgs, user: 'x'.repeat(200000) }).catch((e) => e);
    expect(tooLong).toMatchObject({ retryable: false, message: expect.stringMatching(/OLLAMA_NUM_CTX_LARGE/) });
    expect(requests).toHaveLength(0);
  });

  test('listOllamaModels: the pulled models, or null when Ollama does not answer', async () => {
    replies = [() => ({ body: { models: [{ name: 'qwen2.5-coder:14b' }, { name: 'nomic-embed-text:latest' }] } })];
    const names = await listOllamaModels({ url });
    expect(names).toEqual(['qwen2.5-coder:14b', 'nomic-embed-text:latest']);
    expect(hasModel(names, 'nomic-embed-text')).toBe(true);
    expect(hasModel(names, 'deepseek-r1:14b')).toBe(false);
    expect(await listOllamaModels({ url: 'http://127.0.0.1:1', timeoutMs: 500 })).toBeNull();
  });
});

describe('through callLlm: per-task model and the llmcalls log', () => {
  beforeEach(() => {
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_URL = url;
  });

  test('extract uses OLLAMA_MODEL, judge uses JUDGE_MODEL; each call is logged with real tokens and cost 0', async () => {
    process.env.OLLAMA_MODEL = 'qwen2.5-coder:14b';
    process.env.JUDGE_MODEL = 'deepseek-r1:14b';
    const { user } = await createUser();
    replies = [
      ({ body }) => (body.model === 'deepseek-r1:14b' ? chat('<think>compare</think>{"correct": true, "reason": "same"}', { model: body.model })() : chat('{"candidates": []}')()),
    ];
    const extracted = await callLlmDetailed({ task: 'extract', vars: { message: 'I moved to Pune', recent: '', sentAt: '2026-01-01', categories: 'Personal' }, userId: user._id });
    const judged = await callLlmDetailed({ task: 'judge', vars: { question: 'Where?', gold: 'Pune', candidate: 'Pune' }, userId: user._id });
    expect(extracted).toMatchObject({ provider: 'ollama', model: 'qwen2.5-coder:14b', costUsd: 0, tokensEstimated: false, data: { candidates: [] } });
    expect(judged).toMatchObject({ provider: 'ollama', model: 'deepseek-r1:14b', costUsd: 0, data: { correct: true } });
    expect(requests.map((r) => r.body.model)).toEqual(['qwen2.5-coder:14b', 'deepseek-r1:14b']);
    expect(requests[0].body.format).toEqual(EXTRACT_SCHEMA);

    const calls = await models.LlmCall.find({ userId: user._id }).sort({ _id: 1 }).lean();
    expect(calls.map((c) => [c.task, c.provider, c.model, c.servedModel, c.status])).toEqual([
      ['extract', 'ollama', 'qwen2.5-coder:14b', 'qwen2.5-coder:14b', 'ok'],
      ['judge', 'ollama', 'deepseek-r1:14b', 'deepseek-r1:14b', 'ok'],
    ]);
    for (const c of calls) {
      expect(c).toMatchObject({ inputTokens: 120, outputTokens: 30, costUsd: 0, tokensEstimated: false, attempts: 1, promptId: `${c.task}.v1` });
      expect(c.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('a call that fails after its retry is still logged (status error, both attempts, tokens used)', async () => {
    replies = [chat('no json here')];
    await expect(callLlmDetailed({ task: 'judge', vars: { question: 'Q', gold: 'G', candidate: 'C' } })).rejects.toThrow(LlmError);
    const [call] = await models.LlmCall.find().lean();
    expect(call).toMatchObject({ provider: 'ollama', model: 'deepseek-r1:14b', status: 'error', attempts: 2, inputTokens: 240, costUsd: 0 });
  });
});

describe('embedding provider (fake server)', () => {
  const vectors = (n, dims) => Array.from({ length: n }, (_, i) => Array.from({ length: dims }, (_, j) => (i + j) % 3));
  const embedReply = (dims) => ({ body }) => ({ body: { model: body.model, embeddings: vectors(body.input.length, dims) } });

  test('POST /api/embed with the nomic task prefix; the size comes from the server', async () => {
    replies = [embedReply(5)];
    const emb = new OllamaEmbeddingProvider({ url, model: 'nomic-embed-text' });
    expect(emb.id).toBe('ollama:nomic-embed-text:768'); // first guess, before any call
    const out = await emb.embed(['Lives in Pune'], { inputType: 'document' });
    expect(out[0]).toHaveLength(5);
    expect(emb.dims).toBe(5);
    expect(emb.id).toBe('ollama:nomic-embed-text:5');
    expect(requests[0]).toMatchObject({ path: '/api/embed', body: { model: 'nomic-embed-text', input: ['search_document: Lives in Pune'], truncate: true } });
    await emb.embed(['where do I live?'], { inputType: 'query' });
    expect(requests[1].body.input).toEqual(['search_query: where do I live?']);
    // A new instance (getEmbedder() builds one per call) already knows the learned size
    expect(new OllamaEmbeddingProvider({ url, model: 'nomic-embed-text' }).id).toBe('ollama:nomic-embed-text:5');
  });

  test('an unknown model has no size until ready() asks the server; large inputs are sent in batches', async () => {
    replies = [embedReply(3)];
    const emb = new OllamaEmbeddingProvider({ url, model: 'my-embedder' });
    expect(emb.dims).toBeNull();
    await embeddings.readyEmbedder(emb);
    expect(emb.id).toBe('ollama:my-embedder:3');
    await embeddings.readyEmbedder(emb); // already known: no second call
    expect(requests).toHaveLength(1);
    const many = await emb.embed(Array.from({ length: 70 }, (_, i) => `text ${i}`));
    expect(many).toHaveLength(70);
    expect(requests.slice(1).map((r) => r.body.input.length)).toEqual([64, 6]);
  });

  test('server errors surface; the memory is still saved without a vector (Stage 4 behaviour)', async () => {
    replies = [() => ({ status: 404, body: { error: 'model not found' } })];
    const emb = new OllamaEmbeddingProvider({ url, model: 'nomic-embed-text' });
    await expect(emb.embed(['x'])).rejects.toThrow(/ollama pull nomic-embed-text/);
    embeddings.setEmbedder(emb);
    expect(await embeddings.embeddingFields({ content: 'Lives in Pune' })).toEqual({ embedding: undefined, embeddingModel: null });
  });

  test('backfill after a change of vector size re-embeds every memory with the new size', async () => {
    const { user } = await createUser();
    const category = await createCategory('Personal');
    const old = new Date('2024-01-01T00:00:00Z');
    const rows = Array.from({ length: 4 }, (_, i) => ({ userId: user._id, categoryId: category._id, content: `Fact ${i}`, validFrom: old, recordedAt: old, validTo: null, retractedAt: null }));
    await models.Memory.collection.insertMany(rows);

    replies = [embedReply(4)];
    const first = await backfillEmbeddings({ provider: new OllamaEmbeddingProvider({ url, model: 'nomic-embed-text' }) });
    expect(first).toMatchObject({ model: 'ollama:nomic-embed-text:4', dims: 4, embedded: 4 });

    // The same model name now returns 6 numbers (e.g. another version): the id changes, so every row is redone
    learned.clear();
    replies = [embedReply(6)];
    const second = await backfillEmbeddings({ provider: new OllamaEmbeddingProvider({ url, model: 'nomic-embed-text' }) });
    expect(second).toMatchObject({ model: 'ollama:nomic-embed-text:6', dims: 6, embedded: 4, total: 4 });
    const stored = await models.Memory.find().select('+embedding').lean();
    expect(stored.every((m) => m.embedding.length === 6 && m.embeddingModel === 'ollama:nomic-embed-text:6')).toBe(true);
  });
});

describe('evaluation timing (seconds per item, for the time projection)', () => {
  test('measured seconds per mined message, per answer and per judge call', () => {
    const rows = [
      { system: 'ours', retrieval_ms: 100, answer_ms: 1900, judge_ms: 3000 },
      { system: 'ours', retrieval_ms: 0, answer_ms: 4000, judge_ms: 1000 },
      { system: 'full_context', retrieval_ms: 0, answer_ms: 10000, judge_ms: 2000 },
    ];
    const builds = [{ store: 'raw messages', messages_mined: 0 }, { store: 'bitemporal', messages_mined: 400, build_seconds: 1000 }, { store: 'overwrite', messages_mined: 400, build_seconds: 200 }];
    expect(timing(rows, builds)).toMatchObject({
      seconds_per_message: { bitemporal: 2.5, overwrite: 0.5 },
      seconds_per_answer: { ours: 3, full_context: 10 },
      seconds_per_judge: 2,
      messages_mined_per_store: { bitemporal: 400, overwrite: 400 },
      questions_per_system: { ours: 2, full_context: 1 },
    });
  });
});
