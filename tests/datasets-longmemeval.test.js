const { connect, disconnect, clear, createUser, request, app, api, models } = require('./helpers');
const { loadLongMemEval, buildQuestion, selectQuestions, parseLongMemEvalDate, isAbstention } = require('../services/datasets/longmemeval');
const { loadLocomo } = require('../services/datasets/locomo');
const { hashPassword } = require('../services/authService');
const miniLongMemEval = require('./fixtures/longmemeval-mini');
const miniLocomo = require('./fixtures/locomo-mini');

const { User, Conversation, Message, EvalItem } = models;

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

const counts = async () => ({
  users: await User.countDocuments({ dataset: 'benchmark' }),
  conversations: await Conversation.countDocuments({ dataset: 'benchmark' }),
  messages: await Message.countDocuments({ dataset: 'benchmark' }),
  evalItems: await EvalItem.countDocuments({ dataset: 'benchmark' }),
});

describe('LongMemEval parsing helpers', () => {
  test('dates are read as UTC; impossible or malformed dates are rejected', () => {
    expect(parseLongMemEvalDate('2023/04/10 (Mon) 17:50').toISOString()).toBe('2023-04-10T17:50:00.000Z');
    expect(parseLongMemEvalDate('2024/02/29 (Thu) 00:05').toISOString()).toBe('2024-02-29T00:05:00.000Z');
    expect(() => parseLongMemEvalDate('2023/02/31 (Fri) 10:00')).toThrow(/Unrecognised LongMemEval date/);
    expect(() => parseLongMemEvalDate('2023/04/10 17:50')).toThrow(/Unrecognised/);
    expect(() => parseLongMemEvalDate('yesterday')).toThrow(/Unrecognised/);
    expect(() => parseLongMemEvalDate('2023/04/10 (Mon) 25:00')).toThrow(/Unrecognised/);
  });

  test('abstention questions are the ones whose id ends in _abs', () => {
    expect(isAbstention('gpt4_70e84552_abs')).toBe(true);
    expect(isAbstention('gpt4_70e84552')).toBe(false);
    expect(isAbstention('abs_gpt4')).toBe(false);
  });

  test('a malformed question is rejected with its id, never guessed', () => {
    expect(() => buildQuestion({ question_id: 'x' })).toThrow(/Not a LongMemEval question/);
    const bad = miniLongMemEval()[0];
    bad.haystack_dates.pop();
    expect(() => buildQuestion(bad)).toThrow(/q-update-1.*differ in length/);
    const odd = miniLongMemEval()[0];
    odd.question_type = 'dream-recall';
    expect(() => buildQuestion(odd)).toThrow(/unknown question_type "dream-recall"/);
  });
});

describe('selectQuestions', () => {
  const many = () => {
    const base = miniLongMemEval()[1];
    return Array.from({ length: 12 }, (_, i) => ({ ...base, question_id: `q${i}`, question_type: i % 2 ? 'knowledge-update' : 'temporal-reasoning' }));
  };

  test('without options every question is kept', () => {
    expect(selectQuestions(miniLongMemEval())).toHaveLength(4);
  });

  test('types and ids filter; unknown ones are an error', () => {
    expect(selectQuestions(miniLongMemEval(), { types: ['knowledge-update'] }).map((q) => q.question_id)).toEqual(['q-update-1']);
    expect(selectQuestions(miniLongMemEval(), { ids: ['q-time-4', 'q-count-2'] }).map((q) => q.question_id)).toEqual(['q-count-2', 'q-time-4']);
    expect(() => selectQuestions(miniLongMemEval(), { types: ['dream-recall'] })).toThrow(/Unknown LongMemEval question type/);
    expect(() => selectQuestions(miniLongMemEval(), { ids: ['nope'] })).toThrow(/Unknown LongMemEval question id/);
  });

  test('perType takes N per type, is repeatable for a seed, and keeps file order', () => {
    const first = selectQuestions(many(), { perType: 3, seed: 7 });
    const again = selectQuestions(many(), { perType: 3, seed: 7 });
    expect(first).toHaveLength(6);
    expect(first.map((q) => q.question_id)).toEqual(again.map((q) => q.question_id));
    expect(first.filter((q) => q.question_type === 'knowledge-update')).toHaveLength(3);
    const order = first.map((q) => Number(q.question_id.slice(1)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const other = selectQuestions(many(), { perType: 3, seed: 8 });
    expect(other.map((q) => q.question_id)).not.toEqual(first.map((q) => q.question_id));
  });
});

describe('loadLongMemEval', () => {
  test('maps each question to a user, sessions to conversations, turns to messages and the label to an evalitem', async () => {
    const summary = await loadLongMemEval(miniLongMemEval());
    expect(summary).toMatchObject({ questions: 4, loaded: 4, skipped: 0, users: 4, conversations: 7, messages: 11, evalItems: 4, truncatedTurns: 0 });
    expect(await counts()).toEqual({ users: 4, conversations: 7, messages: 11, evalItems: 4 });

    const user = await User.findOne({ 'source.name': 'longmemeval', 'source.id': 'q-update-1' }).lean();
    expect(user).toMatchObject({ dataset: 'benchmark', email: 'longmemeval-q-update-1@benchmark.invalid', name: 'LongMemEval q-update-1' });
  });

  test('sessions are stored in date order, with ties kept in file order, and turns follow each other by one second', async () => {
    await loadLongMemEval(miniLongMemEval());
    const user = await User.findOne({ 'source.id': 'q-update-1' }).lean();
    const sessions = await Conversation.find({ userId: user._id }).sort({ 'source.session': 1 }).lean();
    expect(sessions.map((c) => [c.source.session, c.source.id])).toEqual([[1, 's-first'], [2, 's-move'], [3, 's-tie']]);
    expect(sessions[0]).toMatchObject({ title: 'LongMemEval q-update-1, session 1', dataset: 'benchmark' });
    expect(sessions.map((c) => c.source.date.toISOString())).toEqual(['2023-06-01T08:00:00.000Z', '2023-06-10T18:05:00.000Z', '2023-06-10T18:05:00.000Z']);

    const first = await Message.find({ conversationId: sessions[0]._id }).sort({ sentAt: 1 }).lean();
    expect(first.map((m) => [m.role, m.source.id, m.source.speaker])).toEqual([['user', 's-first:0', 'user'], ['assistant', 's-first:1', 'assistant'], ['user', 's-first:2', 'user']]);
    expect(first.map((m) => m.sentAt.toISOString())).toEqual(['2023-06-01T08:00:00.000Z', '2023-06-01T08:00:01.000Z', '2023-06-01T08:00:02.000Z']);
    expect(first.every((m) => m.dataset === 'benchmark')).toBe(true);
    expect(first[0].content).toBe('I live in Mumbai, near the sea.');
  });

  test('the label keeps the benchmark values, our category number, the question date and the evidence turns', async () => {
    await loadLongMemEval(miniLongMemEval());
    const user = await User.findOne({ 'source.id': 'q-update-1' }).lean();
    const item = await EvalItem.findOne({ userId: user._id }).lean();
    expect(item).toMatchObject({
      dataset: 'benchmark',
      question: 'Where does Asha live now?',
      answer: 'Pune',
      adversarialAnswer: null,
      category: 5,
      questionType: 'knowledge-update',
      abstention: false,
      evidence: ['s-first:0', 's-move:0'],
      unresolvedEvidence: [],
    });
    expect(item.source).toMatchObject({ name: 'longmemeval', id: 'q-update-1', index: 0 });
    expect(item.questionDate.toISOString()).toBe('2023-06-20T09:30:00.000Z');
    // The evidence ids point at the stored messages, in the order the file marks them
    const evidence = await Promise.all(item.evidenceMessageIds.map((id) => Message.findById(id).lean()));
    expect(evidence.map((m) => [m.source.id, m.content])).toEqual([['s-first:0', 'I live in Mumbai, near the sea.'], ['s-move:0', 'I moved to Pune last week.']]);
  });

  test('numbers become text and an abstention question is flagged but keeps the benchmark answer', async () => {
    await loadLongMemEval(miniLongMemEval());
    const count = await EvalItem.findOne({ 'source.id': 'q-count-2' }).lean();
    expect(count).toMatchObject({ answer: '2', questionType: 'single-session-user', category: 1, abstention: false });
    const abs = await EvalItem.findOne({ 'source.id': 'q-missing-3_abs' }).lean();
    expect(abs).toMatchObject({ abstention: true, questionType: 'single-session-user' });
    expect(abs.answer).toMatch(/not enough/);
    // The same session id in two questions is stored once per question (each question has its own user)
    expect(await Conversation.countDocuments({ 'source.id': 's-cats' })).toBe(2);
  });

  test('re-running skips loaded questions; reset replaces them without leaving orphans', async () => {
    await loadLongMemEval(miniLongMemEval());
    const before = await counts();
    const oldUser = await User.findOne({ 'source.id': 'q-update-1' }).lean();

    expect(await loadLongMemEval(miniLongMemEval())).toMatchObject({ loaded: 0, skipped: 4 });
    expect(await counts()).toEqual(before);

    expect(await loadLongMemEval(miniLongMemEval(), { reset: true })).toMatchObject({ loaded: 4, replaced: 4 });
    expect(await counts()).toEqual(before);
    expect(await User.exists({ _id: oldUser._id })).toBeNull();
    const conversationIds = (await Conversation.find().select('_id').lean()).map((c) => String(c._id));
    expect((await Message.find().lean()).every((m) => conversationIds.includes(String(m.conversationId)))).toBe(true);
    const userIds = (await User.find().select('_id').lean()).map((u) => String(u._id));
    expect((await EvalItem.find().lean()).every((e) => userIds.includes(String(e.userId)))).toBe(true);
  });

  test('a turn over the message limit is cut, marked and counted; nothing else changes', async () => {
    const data = miniLongMemEval().slice(1, 2);
    data[0].haystack_sessions[0][1].content = 'y'.repeat(10001);
    const summary = await loadLongMemEval(data);
    expect(summary.truncatedTurns).toBe(1);
    const long = await Message.findOne({ 'source.id': 's-cats:1' }).lean();
    expect(long.content).toHaveLength(10000);
    expect(long.content.endsWith(' [truncated]')).toBe(true);
  });

  test('a question that fails to load leaves nothing behind (one transaction per question)', async () => {
    const data = miniLongMemEval();
    data[2].question_type = 'dream-recall'; // rejected before anything is written
    await expect(loadLongMemEval(data)).rejects.toThrow(/dream-recall/);
    expect(await User.countDocuments({ 'source.id': 'q-missing-3_abs' })).toBe(0);
    // Questions before the bad one were complete and stay
    expect(await counts()).toMatchObject({ users: 2, evalItems: 2 });
  });
});

describe('LongMemEval next to LoCoMo and the app', () => {
  test('both benchmarks can be loaded together; each keeps its own source name', async () => {
    await loadLocomo(miniLocomo());
    await loadLongMemEval(miniLongMemEval());
    expect(await User.countDocuments({ 'source.name': 'locomo' })).toBe(2);
    expect(await User.countDocuments({ 'source.name': 'longmemeval' })).toBe(4);
    // LoCoMo items have no question date; LongMemEval items do
    expect(await EvalItem.countDocuments({ 'source.name': 'locomo', questionDate: { $exists: true } })).toBe(0);
    expect(await EvalItem.countDocuments({ 'source.name': 'longmemeval', questionDate: { $exists: true } })).toBe(4);
  });

  test('a loaded user can log in and sees only their own sessions; other users see none of them', async () => {
    await loadLongMemEval(miniLongMemEval(), { passwordHash: await hashPassword('Password123') });
    const login = await request(app).post('/api/auth/login').send({ email: 'longmemeval-q-time-4@benchmark.invalid', password: 'Password123' });
    expect(login.status).toBe(200);
    const res = await api(login.body.token).get('/api/conversations');
    expect(res.status).toBe(200);
    expect(res.body.conversations.map((c) => c.title).sort()).toEqual(['LongMemEval q-time-4, session 1', 'LongMemEval q-time-4, session 2']);
    const { token } = await createUser();
    expect((await api(token).get('/api/conversations')).body.conversations).toEqual([]);
  });

  test('deleting a loaded user through the API also deletes its evalitem', async () => {
    await loadLongMemEval(miniLongMemEval(), { passwordHash: await hashPassword('Password123') });
    const login = await request(app).post('/api/auth/login').send({ email: 'longmemeval-q-count-2@benchmark.invalid', password: 'Password123' });
    const res = await api(login.body.token).delete(`/api/users/${login.body.user._id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toMatchObject({ conversations: 1, messages: 2, evalItems: 1 });
    expect(await EvalItem.countDocuments({ 'source.id': 'q-count-2' })).toBe(0);
  });
});
