// Stage 7: GET /api/me/export returns everything stored about the user, and nothing about anyone else
const mongoose = require('mongoose');
const { connect, disconnect, clear, api, createUser, createCategory, models } = require('./helpers');
const worker = require('../services/worker');

const { Memory, Message, Conversation, AuditLog, Job, LlmCall, EvalItem, Consent, Suggestion, User } = models;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  await Promise.all(['Personal', 'Health', 'Learning', 'Hobbies'].map((name) => createCategory(name)));
});

// Gives the user at least one row in every collection that can hold data about a person
async function fillAccount(token, user) {
  await api(token).put('/api/me/consent/Health').send({ mode: 'ask' });
  const conversation = (await api(token).post('/api/conversations').send({ title: 'Chat' })).body;
  const say = (content) => api(token).post(`/api/conversations/${conversation._id}/messages`).send({ role: 'user', content });
  await say('I live in Pune since 2020');
  await worker.drain();
  const moved = (await say('Big news: I moved to Mumbai in March 2024')).body;
  await say('I am allergic to dust');
  await worker.drain();
  await EvalItem.create({ dataset: 'benchmark', source: { name: 'locomo', id: String(user._id), index: 0 }, userId: user._id, question: 'Where?', category: 1, questionType: 'single-hop', evidenceMessageIds: [moved._id] });
}

// The rows each collection holds for this user (messages through the user's conversations)
async function rowsInDatabase(userId) {
  const conversationIds = (await Conversation.find({ userId }).select('_id').lean()).map((c) => c._id);
  return {
    user: await User.countDocuments({ _id: userId }),
    consents: await Consent.countDocuments({ userId }),
    conversations: conversationIds.length,
    messages: await Message.countDocuments({ conversationId: { $in: conversationIds } }),
    memories: await Memory.countDocuments({ userId }),
    auditlog: await AuditLog.countDocuments({ userId }),
    jobs: await Job.countDocuments({ userId }),
    llmcalls: await LlmCall.countDocuments({ userId }),
    evalitems: await EvalItem.countDocuments({ userId }),
    suggestions: await Suggestion.countDocuments({ userId }),
  };
}

describe('GET /api/me/export', () => {
  test('contains every row of every collection about the user (complete), and only theirs', async () => {
    const owner = await createUser();
    const other = await createUser();
    await fillAccount(owner.token, owner.user);
    await fillAccount(other.token, other.user);

    const res = await api(owner.token).get('/api/me/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="ai-memory-export-/);
    const body = res.body;
    expect(body.format).toBe('ai-memory-organizer-export/v1');

    // Complete: the export holds exactly the rows the database holds for this user, and every one is non-empty
    const expected = await rowsInDatabase(owner.user._id);
    for (const [key, count] of Object.entries(expected)) {
      expect(count).toBeGreaterThan(0);
      expect([key, body.counts[key]]).toEqual([key, count]);
    }
    expect(body.memories.map((m) => m.content).sort()).toEqual(['Lives in Mumbai', 'Lives in Pune']); // both versions
    expect(body.suggestions.map((s) => s.content)).toEqual(['Is allergic to dust']);
    expect(body.categories.map((c) => c.name).sort()).toEqual(['Health', 'Personal']);

    // Only theirs: no id of the other user appears anywhere in the file, and no password hash does
    const text = JSON.stringify(body);
    // (booleans, so a failure does not print the whole export)
    expect(text.includes(String(other.user._id))).toBe(false);
    expect(/"passwordHash":|\$2[aby]\$/.test(text)).toBe(false);
  });

  test('every collection in the app is covered, so a new one cannot be forgotten silently', async () => {
    const { token } = await createUser();
    const body = (await api(token).get('/api/me/export')).body;
    // Users are exported as the single "user" object; categories are shared reference data (the ones the
    // user's rows point at are included)
    const keyOf = (name) => (name === 'users' ? 'user' : name);
    const collections = mongoose.modelNames().map((name) => keyOf(mongoose.model(name).collection.name));
    for (const collection of collections) expect([collection, Object.keys(body).includes(collection)]).toEqual([collection, true]);
  });

  test('embedding vectors are left out (and the export says so) unless ?embeddings=true', async () => {
    const { token } = await createUser();
    await api(token).post('/api/memories').send({ content: 'Likes tea', category: 'Personal' });
    const without = (await api(token).get('/api/me/export')).body;
    expect(without.memories[0].embedding).toBeUndefined();
    expect(without.omitted.join(' ')).toMatch(/embeddings=true/);
    const withVectors = (await api(token).get('/api/me/export?embeddings=true')).body;
    expect(withVectors.memories[0].embedding.length).toBeGreaterThan(0);
  });

  test('needs a token', async () => {
    expect((await api().get('/api/me/export')).status).toBe(401);
  });
});
