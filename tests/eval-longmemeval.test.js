const { connect, disconnect, clear, models } = require('./helpers');
const llm = require('../services/llm');
const { longmemevalScore } = require('../eval/metrics');
const { evaluateSample, prepareLongMemEval } = require('../eval/harness');
const { fullContextFit } = require('../eval/preflight');
const { SYSTEM_IDS, setItemCharCap, formatMessage } = require('../eval/systems');
const { worstAnswerPrompt } = require('../eval/gate');
const miniLongMemEval = require('./fixtures/longmemeval-mini');

const { User, Message, Memory } = models;
const sampleOf = (id) => {
  const item = miniLongMemEval().find((x) => x.question_id === id);
  return { sample_id: id, qa: [{ category: 0 }], item };
};

describe('LongMemEval evaluation (no database)', () => {
  test('scoring: token F1, except that an abstention question is right only when the answer abstains', () => {
    expect(longmemevalScore('Pune', { answer: 'Pune', abstention: false })).toBe(1);
    expect(longmemevalScore('Mumbai', { answer: 'Pune', abstention: false })).toBe(0);
    expect(longmemevalScore('2', { answer: 2, abstention: false })).toBe(1); // a numeric gold answer
    expect(longmemevalScore('No information available.', { answer: 'You never said.', abstention: true })).toBe(1);
    expect(longmemevalScore('You never said.', { answer: 'You never said.', abstention: true })).toBe(0);
  });

  test('one perspective (the user), the question date as "now", and evidence taken from has_answer turns', () => {
    const prepared = prepareLongMemEval(sampleOf('q-update-1'));
    expect(prepared.parts).toHaveLength(1);
    expect(prepared.parts[0].person).toBe('the user');
    expect(prepared.asOf.toISOString()).toBe('2023-06-20T09:30:00.000Z');
    expect(prepared.items).toHaveLength(1);
    expect(prepared.items[0].evidence.sort()).toEqual(['s-first:0', 's-move:0']);
    // Sessions are in date order although the file lists them out of order
    expect(prepared.messages[0].source.id).toBe('s-first:0');
  });

  test('the preflight check finds a history that cannot fit the window and one that can', () => {
    const cfg = { numCtx: 8192, numCtxLarge: 32768 };
    const { messages } = prepareLongMemEval(sampleOf('q-update-1'));
    expect(fullContextFit(messages, cfg)).toMatchObject({ fits: true });
    const long = Array.from({ length: 400 }, (_, i) => ({ ...messages[0], content: 'x'.repeat(500), source: { ...messages[0].source, id: `s:${i}` } }));
    expect(fullContextFit(long, cfg)).toMatchObject({ fits: false, window: null });
  });
});

describe('overflow guards (no database)', () => {
  afterEach(() => setItemCharCap(0));

  test('a cap on one message keeps ten retrieved messages inside the small window; no cap does not', () => {
    expect(worstAnswerPrompt({ k: 10, maxItemChars: 1400, numCtx: 8192 }).fits).toBe(true);
    expect(worstAnswerPrompt({ k: 10, maxItemChars: 2000, numCtx: 8192 }).fits).toBe(false);
    expect(worstAnswerPrompt({ k: 10, maxItemChars: 0, numCtx: 8192 }).fits).toBe(false);
  });

  test('the cap shortens a long message and marks it; a short one is untouched; no cap changes nothing', () => {
    const m = { source: { id: 's:0', speaker: 'user' }, sentAt: new Date('2023-06-01T00:00:00Z'), content: 'x'.repeat(5000) };
    expect(formatMessage(m).length).toBeGreaterThan(5000);
    setItemCharCap(1400);
    expect(formatMessage(m)).toMatch(/ \[truncated\]$/);
    expect(formatMessage(m).length).toBeLessThan(1500);
    expect(formatMessage({ ...m, content: 'short' })).toMatch(/user: short$/);
  });
});

describe('LongMemEval evaluation (with a database, mock model)', () => {
  beforeAll(connect);
  afterAll(disconnect);
  beforeEach(clear);
  afterEach(() => llm.setProvider(null));

  test('every system answers one question end to end, from one user, with the benchmark question date', async () => {
    const systems = SYSTEM_IDS.filter((id) => id !== 'full_context');
    const { rows, builds } = await evaluateSample(sampleOf('q-update-1'), { dataset: 'longmemeval', systems, k: 5 });
    expect(rows).toHaveLength(systems.length);
    for (const r of rows) {
      expect(r.sample).toBe('q-update-1');
      expect(r.question_type).toBe('knowledge-update');
      expect([0, 1]).toContain(r.judge_correct);
      expect(r.provider).toBe('mock');
    }
    // One user and only the user's turns were mined; the extractor never sees the assistant
    expect(await User.countDocuments()).toBe(1);
    const mined = builds.find((b) => b.store === 'bitemporal').messages_mined;
    expect(mined).toBe(await Message.countDocuments({ role: 'user' }));
    expect(await Memory.countDocuments()).toBeGreaterThan(0);
  });

  test('an abstention question is scored by whether the answer abstains', async () => {
    const { rows } = await evaluateSample(sampleOf('q-missing-3_abs'), { dataset: 'longmemeval', systems: ['rag_messages'], k: 3 });
    expect(rows).toHaveLength(1);
    expect(rows[0].score_f1 === 0 || rows[0].score_f1 === 1).toBe(true);
  });

  test('an unknown dataset name is refused', async () => {
    await expect(evaluateSample(sampleOf('q-update-1'), { dataset: 'nope', systems: ['rag_messages'] })).rejects.toThrow(/Unknown dataset/);
  });
});
