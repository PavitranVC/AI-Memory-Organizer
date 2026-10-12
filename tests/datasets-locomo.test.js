const { connect, disconnect, clear, createUser, createCategory, request, app, api, models } = require('./helpers');
const { loadLocomo, buildSample, parseLocomoDate, normaliseEvidence } = require('../services/datasets/locomo');
const { hashPassword } = require('../services/authService');
const miniLocomo = require('./fixtures/locomo-mini');

const { User, Conversation, Message, Memory, EvalItem } = models;

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

const counts = async () => ({
  users: await User.countDocuments({ dataset: 'benchmark' }),
  conversations: await Conversation.countDocuments({ dataset: 'benchmark' }),
  messages: await Message.countDocuments({ dataset: 'benchmark' }),
  evalItems: await EvalItem.countDocuments({ dataset: 'benchmark' }),
});

describe('LoCoMo parsing helpers', () => {
  test('dates are read as UTC, including 12 am and 12 pm', () => {
    expect(parseLocomoDate('1:56 pm on 8 May, 2023').toISOString()).toBe('2023-05-08T13:56:00.000Z');
    expect(parseLocomoDate('12:05 am on 3 January, 2024').toISOString()).toBe('2024-01-03T00:05:00.000Z');
    expect(parseLocomoDate('12:30 pm on 25 May, 2023').toISOString()).toBe('2023-05-25T12:30:00.000Z');
    expect(() => parseLocomoDate('yesterday')).toThrow(/Unrecognised LoCoMo date/);
    expect(() => parseLocomoDate('1:56 pm on 8 Mai, 2023')).toThrow(/Unrecognised/);
  });

  test('malformed evidence ids are split and normalised, never guessed', () => {
    expect(normaliseEvidence(['D8:6; D9:17', 'D:11:26', 'D30:05', 'D', 'D1:3'])).toEqual({
      ids: ['D8:6', 'D9:17', 'D11:26', 'D30:5', 'D1:3'],
      invalid: ['D'],
    });
    expect(normaliseEvidence(['D9:1 D4:4'])).toEqual({ ids: ['D9:1', 'D4:4'], invalid: [] });
    expect(normaliseEvidence(undefined)).toEqual({ ids: [], invalid: [] });
  });

  test('a sample without speakers or qa is rejected', () => {
    expect(() => buildSample({ sample_id: 'x', conversation: {} })).toThrow(/Not a LoCoMo sample/);
  });
});

describe('loadLocomo', () => {
  test('maps samples to users, sessions to conversations, turns to messages and qa to evalitems', async () => {
    const summary = await loadLocomo(miniLocomo());
    expect(summary).toMatchObject({ samples: 2, loaded: 2, skipped: 0, users: 2, conversations: 4, messages: 9, evalItems: 8 });
    expect(await counts()).toEqual({ users: 2, conversations: 4, messages: 9, evalItems: 8 });

    const user = await User.findOne({ 'source.name': 'locomo', 'source.id': 'test-1' }).lean();
    expect(user).toMatchObject({ dataset: 'benchmark', email: 'locomo-test-1@benchmark.invalid', name: 'Asha & Ben (LoCoMo test-1)' });

    // Sessions are ordered by number (1, 2, 10), carry their date, and a date with no turns makes no conversation
    const sessions = await Conversation.find({ userId: user._id }).sort({ 'source.session': 1 }).lean();
    expect(sessions.map((c) => c.source.session)).toEqual([1, 2, 10]);
    expect(sessions[0]).toMatchObject({ title: 'LoCoMo test-1, session 1', dataset: 'benchmark' });
    expect(sessions[2].source.date.toISOString()).toBe('2024-01-03T00:05:00.000Z');

    // speaker_a is the 'user', speaker_b the 'assistant'; names, dialog ids and image captions are kept
    const first = await Message.find({ conversationId: sessions[0]._id }).sort({ sentAt: 1 }).lean();
    expect(first.map((m) => [m.role, m.source.speaker, m.source.id])).toEqual([['user', 'Asha', 'D1:1'], ['assistant', 'Ben', 'D1:2'], ['user', 'Asha', 'D1:3']]);
    expect(first[1].content).toBe('Nice! Look at my new bike. [shared an image: a red bicycle]');
    expect(first.map((m) => m.sentAt.toISOString())).toEqual(['2023-05-08T13:56:00.000Z', '2023-05-08T13:56:01.000Z', '2023-05-08T13:56:02.000Z']);
    expect(first.every((m) => m.dataset === 'benchmark')).toBe(true);
  });

  test('qa labels keep the benchmark values and resolve evidence to loaded messages', async () => {
    await loadLocomo(miniLocomo());
    const user = await User.findOne({ 'source.id': 'test-1' }).lean();
    const items = await EvalItem.find({ userId: user._id }).sort({ 'source.index': 1 }).lean();
    const byDia = Object.fromEntries((await Message.find({ dataset: 'benchmark' }).lean()).filter((m) => m.source.id).map((m) => [`${m.conversationId}|${m.source.id}`, m]));
    const messageFor = async (id) => Message.findById(id).lean();

    expect(items).toHaveLength(7);
    expect(items[0]).toMatchObject({ question: 'What instrument did Asha start learning in May 2023?', answer: 'violin', category: 4, questionType: 'single-hop', unresolvedEvidence: [] });
    expect((await messageFor(items[0].evidenceMessageIds[0])).source.id).toBe('D1:1');
    expect(items[1].questionType).toBe('temporal');
    expect(items[2].answer).toBe('2'); // numbers become text
    // "D1:1; D10:2" points at two messages in two sessions
    expect(items[3].questionType).toBe('multi-hop');
    expect((await Promise.all(items[3].evidenceMessageIds.map(messageFor))).map((m) => m.source.id)).toEqual(['D1:1', 'D10:2']);
    // "D:1:02" is normalised to D1:2
    expect((await messageFor(items[4].evidenceMessageIds[0])).source.id).toBe('D1:2');
    expect(items[4].evidence).toEqual(['D:1:02']); // the original text is kept as well
    // Adversarial: no answer, the tempting wrong one is kept, and unmatched ids are listed
    expect(items[5]).toMatchObject({ answer: null, adversarialAnswer: 'it is out of tune', questionType: 'adversarial', evidenceMessageIds: [], unresolvedEvidence: ['D', 'D9:9'] });
    expect(items[6]).toMatchObject({ questionType: 'open-domain', evidence: [], evidenceMessageIds: [] });
    expect(Object.keys(byDia)).toHaveLength(9);
  });

  test('re-running skips loaded samples; reset replaces them without leaving orphans', async () => {
    await loadLocomo(miniLocomo());
    const before = await counts();
    const oldUser = await User.findOne({ 'source.id': 'test-1' }).lean();

    expect(await loadLocomo(miniLocomo())).toMatchObject({ loaded: 0, skipped: 2 });
    expect(await counts()).toEqual(before);

    expect(await loadLocomo(miniLocomo(), { reset: true })).toMatchObject({ loaded: 2, replaced: 2 });
    expect(await counts()).toEqual(before);
    expect(await User.exists({ _id: oldUser._id })).toBeNull();
    // Every message belongs to an existing conversation and every evalitem to an existing user
    const conversationIds = (await Conversation.find().select('_id').lean()).map((c) => String(c._id));
    expect((await Message.find().lean()).every((m) => conversationIds.includes(String(m.conversationId)))).toBe(true);
    const userIds = (await User.find().select('_id').lean()).map((u) => String(u._id));
    expect((await EvalItem.find().lean()).every((e) => userIds.includes(String(e.userId)))).toBe(true);
  });

  test('a sample that fails to load leaves nothing behind (one transaction per sample)', async () => {
    const data = miniLocomo();
    data[1].conversation.session_1[0].text = 'x'.repeat(10001); // longer than Message allows
    await expect(loadLocomo(data)).rejects.toThrow();
    expect(await User.countDocuments({ 'source.id': 'test-2' })).toBe(0);
    expect(await Conversation.countDocuments({ 'source.id': 'test-2' })).toBe(0);
    // The first sample was complete and stays
    expect(await counts()).toMatchObject({ users: 1, conversations: 3, messages: 7, evalItems: 7 });
  });
});

describe('loaded benchmark data in the app', () => {
  test('a loaded user can log in and sees only their own sessions; other users see none of them', async () => {
    await loadLocomo(miniLocomo(), { passwordHash: await hashPassword('Password123') });
    const login = await request(app).post('/api/auth/login').send({ email: 'locomo-test-2@benchmark.invalid', password: 'Password123' });
    expect(login.status).toBe(200);
    const res = await api(login.body.token).get('/api/conversations');
    expect(res.status).toBe(200);
    expect(res.body.conversations.map((c) => c.title)).toEqual(['LoCoMo test-2, session 1']);

    const { token } = await createUser();
    expect((await api(token).get('/api/conversations')).body.conversations).toEqual([]);
  });

  test('memories from a benchmark conversation inherit the label, through supersede too', async () => {
    await loadLocomo(miniLocomo(), { passwordHash: await hashPassword('Password123') });
    await createCategory('Health');
    const login = await request(app).post('/api/auth/login').send({ email: 'locomo-test-2@benchmark.invalid', password: 'Password123' });
    const conversation = await Conversation.findOne({ 'source.id': 'test-2' }).lean();
    const message = await Message.findOne({ conversationId: conversation._id }).lean();

    const created = await api(login.body.token).post('/api/memories').send({ content: 'Allergic to peanuts', category: 'Health', conversationId: String(conversation._id), sourceMessageIds: [String(message._id)] });
    expect(created.status).toBe(201);
    expect(created.body.dataset).toBe('benchmark');
    const updated = await api(login.body.token).put(`/api/memories/${created.body._id}`).send({ content: 'Allergic to peanuts and cashews' });
    expect(updated.status).toBe(200);
    expect((await Memory.findById(updated.body._id).lean()).dataset).toBe('benchmark');

    // A client cannot label its own memory
    const { token } = await createUser();
    const own = await api(token).post('/api/memories').send({ content: 'Likes tea', category: 'Health', dataset: 'benchmark' });
    expect(own.status).toBe(201);
    expect(own.body.dataset).toBeUndefined();
  });

  test('deleting a loaded user through the API also deletes its evalitems', async () => {
    await loadLocomo(miniLocomo(), { passwordHash: await hashPassword('Password123') });
    const login = await request(app).post('/api/auth/login').send({ email: 'locomo-test-2@benchmark.invalid', password: 'Password123' });
    const res = await api(login.body.token).delete(`/api/users/${login.body.user._id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toMatchObject({ conversations: 1, messages: 2, evalItems: 1 });
    expect(await EvalItem.countDocuments({ 'source.id': 'test-2' })).toBe(0);
  });
});
