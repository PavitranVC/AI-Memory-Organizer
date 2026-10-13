const { connect, disconnect, clear, createUser, createCategory, models } = require('./helpers');
const llm = require('../services/llm');
const { AnthropicProvider } = require('../services/llm/anthropicProvider');
const { MockProvider, evalAnswer, judge } = require('../services/llm/mockProvider');
const extraction = require('../services/extractionService');
const { retrieve } = require('../services/retrieval');
const { tokenF1, locomoScore, recallAtK, abstains } = require('../eval/metrics');
const { percentile, pairedBootstrap, bootstrapMean } = require('../eval/stats');
const report = require('../eval/report');
const { cohenKappa } = require('../eval/judge-agreement');
const { evaluateSample, pickQuestions, mirror } = require('../eval/harness');
const { SYSTEM_IDS, formatMemory } = require('../eval/systems');
const { buildSample } = require('../services/datasets/locomo');
const miniLocomo = require('./fixtures/locomo-mini');

const { Memory, Conversation, Message, User } = models;

describe('metrics (no database)', () => {
  test('token F1 ignores case, punctuation and articles, and gives partial credit', () => {
    expect(tokenF1('The Boston!', 'boston')).toBe(1);
    expect(tokenF1('pottery and camping', 'camping')).toBeCloseTo(2 / 3);
    expect(tokenF1('Paris', 'Boston')).toBe(0);
  });

  test('LoCoMo-style scoring per category', () => {
    // multi-hop: each comma-separated gold part matched with its best prediction part
    expect(locomoScore('camping, pottery', { category: 1, answer: 'pottery, camping' })).toBe(1);
    // open-domain: only the gold text before ";" counts
    expect(locomoScore('yes', { category: 3, answer: 'yes; because she likes it' })).toBe(1);
    // adversarial: correct only when the answer abstains
    expect(locomoScore('No information available.', { category: 5, answer: null })).toBe(1);
    expect(locomoScore('Sweden', { category: 5, answer: null })).toBe(0);
    expect(abstains('It is not mentioned in the conversation')).toBe(true);
  });

  test('recall@k is the share of evidence turns in the context, null without evidence', () => {
    expect(recallAtK(['D1:1', 'D1:3'], ['D1:3', 'D2:1'])).toBe(0.5);
    expect(recallAtK([], ['D1:1'])).toBeNull();
  });
});

describe('statistics (no database)', () => {
  test('nearest-rank percentiles', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
  });

  test('bootstrap intervals are seeded and bracket the observed value', () => {
    const scores = [1, 0, 1, 1, 0, 1, 0, 1, 1, 1];
    const a = bootstrapMean(scores);
    expect(a).toEqual(bootstrapMean(scores));
    expect(a.low).toBeLessThanOrEqual(a.mean);
    expect(a.high).toBeGreaterThanOrEqual(a.mean);
    const same = pairedBootstrap(scores, scores);
    expect([same.diff, same.low, same.high]).toEqual([0, 0, 0]);
    expect(() => pairedBootstrap([1], [1, 0])).toThrow();
  });

  test('Cohen kappa: 1 for perfect agreement, 0 at chance level', () => {
    expect(cohenKappa([[1, 1], [0, 0], [1, 1], [0, 0]]).kappa).toBe(1);
    expect(cohenKappa([[1, 1], [1, 0], [0, 1], [0, 0]]).kappa).toBe(0);
  });
});

describe('summaries (no database)', () => {
  const row = (system, i, correct) => ({ system, sample: 's', qa_index: i, question_type: 'single-hop', score_f1: correct, judge_correct: correct, recall_at_k: null, insufficient: false, retrieval_ms: 1, answer_ms: 1, context_tokens_est: 10, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, tokens_estimated: true, answer_cost_usd: 0 });
  const rows = [0, 1, 2, 3].flatMap((i) => [row('ours', i, 1), row('full_context', i, i % 2)]);

  test('per-system table, paired comparison against ours, and a blind labelling sample', () => {
    const [ours, full] = report.bySystem(rows, ['ours', 'full_context']);
    expect([ours.n, ours.judge_accuracy, full.judge_accuracy]).toEqual([4, 1, 0.5]);
    expect(full.recall_at_k_mean).toBeNull();
    const versus = report.versusOurs(rows).find((r) => r.metric === 'judge_correct');
    expect(versus).toMatchObject({ comparison: 'ours - full_context', n: 4, diff: 0.5 });
    const jv = report.judgeValidation(rows, 5);
    expect(jv.toLabel).toHaveLength(5);
    expect(Object.keys(jv.toLabel[0])).not.toContain('system');
    expect(Object.keys(jv.toLabel[0])).not.toContain('judge_correct');
    expect(jv.key[0]).toHaveProperty('system');
  });

  test('a pilot sample covers every question category', () => {
    const qa = [1, 1, 1, 2, 2, 3, 4, 4, 5, 5].map((category) => ({ category }));
    const picked = pickQuestions(qa, 5);
    expect(new Set(picked.map((i) => qa[i].category)).size).toBe(5);
    expect(pickQuestions(qa, 0)).toHaveLength(10);
  });

  test('the ablated context hides dates (also in the source quote) and provenance', () => {
    const message = { _id: 'x', content: 'I live in Pune', sentAt: new Date('2023-05-08'), source: { id: 'D1:1', speaker: 'Asha' } };
    const memory = { content: 'Lives in Pune', validFrom: new Date('2023-05-08'), validTo: null, sourceMessageIds: ['x'] };
    const sources = new Map([['x', message]]);
    expect(formatMemory('m1', memory, 'Asha', sources, { temporal: true, provenance: true })).toBe('[m1] about Asha: Lives in Pune | validFrom 2023-05-08 | validTo  | source [D1:1] 2023-05-08 Asha: "I live in Pune"');
    expect(formatMemory('m1', memory, 'Asha', sources, { temporal: false, provenance: true })).not.toMatch(/2023/);
    expect(formatMemory('m1', memory, 'Asha', sources, { temporal: true, provenance: false })).not.toMatch(/D1:1|source/);
  });
});

describe('LLM plumbing for the evaluation (no database calls to a real API)', () => {
  test('the mock answer and judge are deterministic stand-ins', () => {
    expect(evalAnswer('Where does Asha live?', [{ label: 'm1', text: 'Asha lives in Pune' }])).toMatchObject({ citedMemories: ['m1'], insufficient: false });
    expect(evalAnswer('Where does Asha live?', [{ label: 'm1', text: 'Nothing related' }])).toMatchObject({ answer: 'No information available.', insufficient: true });
    expect(judge('Pune', 'Pune').correct).toBe(true);
    expect(judge(null, 'Sweden').correct).toBe(false);
  });

  test('the full-context prefix gets its own cache breakpoint; the question comes after it', () => {
    const request = new AnthropicProvider({ client: {}, config: { effort: 'low', fallbacks: null } }).buildRequest({ model: 'm', system: 'S', userPrefix: 'CONVERSATION', user: 'QUESTION', schema: {}, maxTokens: 10 });
    expect(request.messages[0].content).toEqual([
      { type: 'text', text: 'CONVERSATION', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'QUESTION' },
    ]);
    const plain = new AnthropicProvider({ client: {}, config: { effort: 'low', fallbacks: null } }).buildRequest({ model: 'm', system: 'S', user: 'QUESTION', schema: {}, maxTokens: 10 });
    expect(plain.messages[0].content).toBe('QUESTION');
  });
});

describe('with a database', () => {
  beforeAll(connect);
  afterAll(disconnect);
  beforeEach(clear);
  afterEach(() => llm.setProvider(null));

  test('callLlmDetailed splits the prompt at the cache-break marker only when asked, and reports usage', async () => {
    const seen = [];
    const mock = new MockProvider();
    llm.setProvider({ name: 'mock', generateJson: (args) => seen.push(args) && mock.generateJson(args) });
    const vars = { asOf: '2024-01-04', contextKind: 'test', context: 'CTX LINE', question: 'Q?' };
    const out = await llm.callLlmDetailed({ task: 'eval_answer', vars, extra: { question: 'Q?', items: [] }, cachePrefix: true });
    expect(seen[0].userPrefix).toMatch(/CTX LINE/);
    expect(seen[0].user).toMatch(/Q\?/);
    expect(seen[0].user).not.toMatch(/CTX LINE/);
    expect(out).toMatchObject({ provider: 'mock', tokensEstimated: true, costUsd: 0 });
    expect(out.usage.inputTokens).toBeGreaterThan(0);
    await llm.callLlmDetailed({ task: 'eval_answer', vars, extra: { question: 'Q?', items: [] } });
    expect(seen[1].userPrefix).toBeNull();
    expect(seen[1].user).not.toMatch(/cache-break/);
  });

  async function twoMessages(user) {
    const category = await createCategory('Personal');
    await createCategory('Hobbies');
    const conversation = await Conversation.create({ userId: user._id, title: 't' });
    const say = (content, sentAt) => Message.create({ conversationId: conversation._id, role: 'user', content, sentAt: new Date(sentAt) });
    return { category, conversation, first: await say('I live in Pune since 2020', '2023-01-01'), second: await say('I moved to Mumbai in March 2024', '2024-04-01') };
  }

  test('overwrite-style baseline: a changed fact replaces the memory in place, with no history', async () => {
    const { user } = await createUser();
    const { conversation, first, second } = await twoMessages(user);
    for (const m of [first, second]) await extraction.processMessage({ userId: user._id, messageId: m._id, conversationId: conversation._id }, { versioning: 'overwrite' });
    const all = await Memory.find({ userId: user._id }).lean();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ content: 'Lives in Mumbai', validTo: null, supersedes: null });
    expect(all[0].sourceMessageIds.map(String)).toEqual([String(second._id)]);
    await expect(extraction.processMessage({ userId: user._id, messageId: first._id, conversationId: conversation._id }, { versioning: 'nope' })).rejects.toThrow(/versioning/);
  });

  test('the shared extraction cache gives two stores the same facts with one extraction call', async () => {
    const { user } = await createUser();
    const { conversation, first } = await twoMessages(user);
    await Message.updateOne({ _id: first._id }, { $set: { source: { name: 'locomo', id: 'D1:1', speaker: 'Asha' } } });
    const spy = jest.spyOn(MockProvider.prototype, 'generateJson');
    const cache = new Map();
    await extraction.processMessage({ userId: user._id, messageId: first._id, conversationId: conversation._id }, { extractionCache: cache });
    await Memory.deleteMany({ userId: user._id });
    await extraction.processMessage({ userId: user._id, messageId: first._id, conversationId: conversation._id }, { versioning: 'overwrite', extractionCache: cache });
    expect(spy.mock.calls.filter(([args]) => args.task === 'extract')).toHaveLength(1);
    expect(await Memory.countDocuments({ userId: user._id })).toBe(1);
    spy.mockRestore();
  });

  test('retrieve(allVersions) also returns superseded versions, for the no-temporal ablation only', async () => {
    const { user } = await createUser();
    const { conversation, first, second } = await twoMessages(user);
    for (const m of [first, second]) await extraction.processMessage({ userId: user._id, messageId: m._id, conversationId: conversation._id });
    const current = await retrieve(user._id, { query: 'where does the user live', touch: false });
    const every = await retrieve(user._id, { query: 'where does the user live', touch: false, allVersions: true });
    expect(current.results.map((r) => r.memory.content)).toEqual(['Lives in Mumbai']);
    expect(every.results.map((r) => r.memory.content).sort()).toEqual(['Lives in Mumbai', 'Lives in Pune']);
  });

  test('the harness runs every system end to end on a LoCoMo-format sample (mock model)', async () => {
    const [sample] = miniLocomo();
    const built = buildSample(sample);
    const mirrored = mirror(built, sample.conversation.speaker_b);
    // The mirror swaps the roles, so each speaker's turns are 'user' messages in exactly one perspective
    expect(mirrored.messages.map((m) => m.role)).toEqual(built.messages.map((m) => (m.role === 'user' ? 'assistant' : 'user')));

    const { rows, builds } = await evaluateSample(sample, { questions: 0, k: 5 });
    expect(rows).toHaveLength(SYSTEM_IDS.length * sample.qa.length);
    for (const r of rows) {
      expect([0, 1]).toContain(r.judge_correct);
      expect(r.score_f1).toBeGreaterThanOrEqual(0);
      expect(r.provider).toBe('mock');
    }
    expect(rows.filter((r) => r.system === 'full_context').every((r) => r.recall_at_k === null || r.recall_at_k === 1)).toBe(true);
    const stores = builds.map((b) => b.store);
    expect(stores).toEqual(expect.arrayContaining(['raw messages', 'rag message vectors', 'bitemporal', 'overwrite']));
    // Both speakers were mined: messages of each perspective were processed
    const mined = builds.find((b) => b.store === 'bitemporal').messages_mined;
    expect(mined).toBe(built.messages.length);
    // The overwrite store reused the bitemporal store's extractions (no second extraction call)
    expect(builds.find((b) => b.store === 'overwrite').extract_calls).toBe(0);
    expect(await User.countDocuments()).toBe(2);
  });

  test('a failed answer, judge or extraction call is recorded and scored as wrong, not fatal to the run', async () => {
    const [sample] = miniLocomo();
    const mock = new MockProvider();
    let extractCalls = 0;
    // Every full_context answer fails (like a local model cut off at its token cap), the judge fails on the
    // first rag answer, and the first extraction fails
    let ragJudged = 0;
    llm.setProvider({
      name: 'mock',
      async generateJson(args) {
        if (args.task === 'extract' && extractCalls++ === 0) throw new Error('simulated extraction failure');
        if (args.task === 'eval_answer' && args.vars.items.length > 0 && args.userPrefix) throw new Error('simulated cut-off');
        if (args.task === 'judge' && ragJudged++ === 0 && /\[D/.test(String(args.vars.candidate))) throw new Error('simulated judge failure');
        return mock.generateJson(args);
      },
    });
    try {
      const { rows, builds } = await evaluateSample(sample, { questions: 0, k: 5, systems: ['full_context', 'rag_messages', 'ours'] });
      const full = rows.filter((r) => r.system === 'full_context');
      expect(full).toHaveLength(sample.qa.length);
      expect(full.every((r) => r.error && r.error.startsWith('answer:') && r.score_f1 === 0 && r.judge_correct === 0)).toBe(true);
      expect(rows.filter((r) => r.system === 'ours').length).toBe(sample.qa.length);
      expect(builds.find((b) => b.store === 'bitemporal').failed_messages).toBe(1);
      const summary = report.bySystem(rows, ['full_context', 'rag_messages', 'ours']);
      expect(summary.find((r) => r.system === 'full_context').errors).toBe(sample.qa.length);
      expect(summary.find((r) => r.system === 'ours').errors).toBe(0);
    } finally {
      llm.setProvider(null);
    }
  });
});
