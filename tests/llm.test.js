// Unit tests of the LLM layer. No database and no network: the Anthropic provider gets a fake SDK client.
const { llmConfig, DEFAULT_MODEL } = require('../services/llm/config');
const { loadPrompt, render, ACTIVE } = require('../services/llm/prompts');
const { costUsd } = require('../services/llm/pricing');
const { EXTRACT_SCHEMA, validateExtraction, validateDecision } = require('../services/llm/schemas');
const { MockProvider, extract, reconcile } = require('../services/llm/mockProvider');
const { AnthropicProvider } = require('../services/llm/anthropicProvider');
const { LlmError, LlmRefusalError } = require('../services/llm/errors');

describe('config', () => {
  test('defaults: mock provider, claude-opus-5-5 for every task, medium effort, server-side fallback on', () => {
    const config = llmConfig({});
    expect(config.provider).toBe('mock');
    expect(config.models).toEqual({ extract: DEFAULT_MODEL, reconcile: DEFAULT_MODEL, answer: DEFAULT_MODEL, judge: DEFAULT_MODEL });
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(config.effort).toBe('medium');
    expect(config.fallbacks).toBe('default');
  });

  test('environment overrides, and invalid values are rejected', () => {
    const config = llmConfig({ LLM_PROVIDER: 'Anthropic', EXTRACTION_MODEL: 'claude-sonnet-5-5', LLM_EFFORT: 'low', LLM_FALLBACKS: 'off' });
    expect(config).toMatchObject({ provider: 'anthropic', effort: 'low', fallbacks: null });
    expect(config.models.extract).toBe('claude-sonnet-5-5');
    expect(config.models.reconcile).toBe(DEFAULT_MODEL);
    expect(() => llmConfig({ LLM_PROVIDER: 'openai' })).toThrow(/LLM_PROVIDER/);
    expect(() => llmConfig({ LLM_EFFORT: 'huge' })).toThrow(/LLM_EFFORT/);
  });
});

describe('versioned prompts', () => {
  test.each(Object.keys(ACTIVE))('%s: loads, has a stable system part and a user template', (task) => {
    const prompt = loadPrompt(task);
    expect(prompt.id).toBe(ACTIVE[task]);
    expect(prompt.hash).toMatch(/^[0-9a-f]{12}$/);
    // Nothing that changes per call may be in the cached system part
    expect(prompt.system).not.toMatch(/\{\{/);
    expect(prompt.userTemplate).toMatch(/\{\{\w+\}\}/);
  });

  test('the system part is long enough to be cached (rough check: 512 tokens is about 2,000 characters)', () => {
    for (const task of Object.keys(ACTIVE)) expect(loadPrompt(task).system.length).toBeGreaterThan(2000);
  });

  test('render fills placeholders and refuses a missing one', () => {
    expect(render('a {{x}} b', { x: 1 })).toBe('a 1 b');
    expect(() => render('a {{x}} {{y}}', { x: 1 })).toThrow(/"y" is missing/);
  });
});

describe('pricing', () => {
  test('cost of a call on claude-opus-5-5 ($4 in, $20 out, $0.20 cache read, $5 cache write per million)', () => {
    const cost = costUsd('claude-opus-5-5', { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 });
    expect(cost).toBeCloseTo(4 + 20 + 0.2 + 5, 6);
  });

  test('an unknown model has no price (null), never a silent $0', () => {
    expect(costUsd('some-other-model', { inputTokens: 100 })).toBeNull();
  });
});

describe('output validation', () => {
  const good = { content: 'Lives in Pune', topic: 'Home City', category: 'Personal', importance: 4, confidence: 0.9, sensitivity: 'normal', validFrom: '2020-01-01' };

  test('keeps well-formed candidates and reports the others', () => {
    const { candidates, rejected } = validateExtraction({
      candidates: [good, { ...good, importance: 9 }, { ...good, confidence: 2 }, { ...good, sensitivity: 'secret' }, { ...good, content: ' ' }],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ content: 'Lives in Pune', topic: 'home city', validFrom: new Date('2020-01-01') });
    expect(rejected.map((r) => r.index)).toEqual([1, 2, 3, 4]);
    expect(() => validateExtraction({})).toThrow();
  });

  test('a decision may only target one of the memories shown to the model', () => {
    expect(validateDecision({ action: 'SUPERSEDE', targetMemoryId: 'a', content: 'x', reason: 'r' }, ['a'])).toMatchObject({ action: 'SUPERSEDE', targetMemoryId: 'a' });
    expect(() => validateDecision({ action: 'SUPERSEDE', targetMemoryId: 'zzz', content: 'x', reason: 'r' }, ['a'])).toThrow(/not one of the memories shown/);
    expect(() => validateDecision({ action: 'DELETE_ALL', targetMemoryId: null, content: '', reason: '' }, ['a'])).toThrow(/action/);
    expect(validateDecision({ action: 'ADD', targetMemoryId: 'ignored', content: 'x', reason: 'r' }, [])).toMatchObject({ action: 'ADD', targetMemoryId: null });
  });

  test('the extraction schema is strict (structured outputs need additionalProperties: false)', () => {
    expect(EXTRACT_SCHEMA.additionalProperties).toBe(false);
    expect(EXTRACT_SCHEMA.properties.candidates.items.additionalProperties).toBe(false);
  });
});

describe('mock provider (deterministic test double)', () => {
  test('extracts durable facts about the user and ignores chit-chat', () => {
    expect(extract('Hi! How are you today?').candidates).toEqual([]);
    const { candidates } = extract('I moved to Mumbai in March 2024 and I work at Tata Steel. I am allergic to peanuts');
    expect(candidates.map((c) => [c.content, c.topic, c.category, c.sensitivity, c.validFrom])).toEqual([
      ['Lives in Mumbai', 'home city', 'Personal', 'normal', '2024-03-01'],
      ['Works at Tata Steel', 'employer', 'Personal', 'normal', null],
      ['Is allergic to peanuts', 'allergy', 'Health', 'special', null],
    ]);
  });

  test('reconciles: NOOP for the same fact, SUPERSEDE for a new value of a one-value topic, UPDATE for more detail, else ADD', () => {
    const pune = { id: 'm1', content: 'Lives in Pune', tags: ['home city'] };
    expect(reconcile({ content: 'lives in pune', topic: 'home city' }, [pune]).action).toBe('NOOP');
    expect(reconcile({ content: 'Lives in Mumbai', topic: 'home city' }, [pune])).toMatchObject({ action: 'SUPERSEDE', targetMemoryId: 'm1' });
    expect(reconcile({ content: 'Likes black coffee', topic: 'hobby' }, [{ id: 'm2', content: 'Likes coffee', tags: ['hobby'] }])).toMatchObject({ action: 'UPDATE', targetMemoryId: 'm2' });
    expect(reconcile({ content: 'Is allergic to shellfish', topic: 'allergy' }, [{ id: 'm3', content: 'Is allergic to peanuts', tags: ['allergy'] }]).action).toBe('ADD');
  });

  test('same input, same output, with estimated token counts', async () => {
    const mock = new MockProvider();
    const args = { task: 'extract', model: 'm', system: 'x'.repeat(400), user: 'y'.repeat(40), vars: { message: 'I live in Pune' } };
    const a = await mock.generateJson(args);
    expect(await mock.generateJson(args)).toEqual(a);
    expect(a.usage.inputTokens).toBe(110);
    await expect(mock.generateJson({ ...args, vars: { message: '[mock:refuse]' } })).rejects.toBeInstanceOf(LlmRefusalError);
  });
});

describe('Anthropic provider (fake SDK client, no network)', () => {
  const config = { effort: 'medium', fallbacks: 'default' };
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  const okResponse = {
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"candidates":[]}' }],
    usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  };
  function fakeClient(response) {
    const calls = [];
    const create = async (request) => {
      calls.push(request);
      if (response instanceof Error) throw response;
      return response;
    };
    return { calls, client: { messages: { create }, beta: { messages: { create } } } };
  }

  test('sends the stable prompt first with cache_control, a JSON schema, effort and the fallback opt-in', async () => {
    const { calls, client } = fakeClient(okResponse);
    const provider = new AnthropicProvider({ client, config });
    const result = await provider.generateJson({ model: 'claude-opus-5-5', system: 'STABLE', user: 'VOLATILE', schema, maxTokens: 8000 });

    const [request] = calls;
    expect(request.model).toBe('claude-opus-5-5');
    expect(request.system).toEqual([{ type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } }]);
    expect(request.messages).toEqual([{ role: 'user', content: 'VOLATILE' }]);
    expect(request.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema } });
    expect(request.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(request.fallbacks).toBe('default');
    expect(request.thinking).toBeUndefined(); // Opus 5.5 thinks adaptively; "disabled" would be a 400

    expect(result.data).toEqual({ candidates: [] });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 0 });
  });

  test('without fallbacks it uses the plain messages endpoint and no beta header', async () => {
    const { calls, client } = fakeClient(okResponse);
    await new AnthropicProvider({ client, config: { effort: 'low', fallbacks: null } }).generateJson({ model: 'm', system: 's', user: 'u', schema });
    expect(calls[0].betas).toBeUndefined();
    expect(calls[0].fallbacks).toBeUndefined();
  });

  test('a refusal is checked before the content and is not retryable', async () => {
    const { client } = fakeClient({ ...okResponse, stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] });
    const err = await new AnthropicProvider({ client, config }).generateJson({ model: 'm', system: 's', user: 'u', schema }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmRefusalError);
    expect(err.retryable).toBe(false);
    expect(err.category).toBe('cyber');
    expect(err.result.usage.inputTokens).toBe(120); // still logged
  });

  test('a cut-off answer and invalid JSON are retryable errors', async () => {
    const cut = await new AnthropicProvider({ client: fakeClient({ ...okResponse, stop_reason: 'max_tokens' }).client, config })
      .generateJson({ model: 'm', system: 's', user: 'u', schema })
      .catch((e) => e);
    expect(cut).toBeInstanceOf(LlmError);
    expect(cut.retryable).toBe(true);
    const bad = await new AnthropicProvider({ client: fakeClient({ ...okResponse, content: [{ type: 'text', text: 'not json' }] }).client, config })
      .generateJson({ model: 'm', system: 's', user: 'u', schema })
      .catch((e) => e);
    expect(bad.message).toMatch(/not valid JSON/);
  });

  test('API errors: 400/401 are not retried, 429 and 5xx are', async () => {
    const run = (status) =>
      new AnthropicProvider({ client: fakeClient(Object.assign(new Error('boom'), { status })).client, config })
        .generateJson({ model: 'm', system: 's', user: 'u', schema })
        .catch((e) => e);
    expect((await run(400)).retryable).toBe(false);
    expect((await run(401)).retryable).toBe(false);
    expect((await run(429)).retryable).toBe(true);
    expect((await run(529)).retryable).toBe(true);
  });

  test('without a client it needs ANTHROPIC_API_KEY (tests never have one)', () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(() => new AnthropicProvider({ config })).toThrow(/ANTHROPIC_API_KEY/);
  });
});
