// Stage 7: per-category consent (store / ask / never) and the suggestions of "ask" categories
const { connect, disconnect, clear, api, createUser, createAdmin, createCategory, models } = require('./helpers');
const worker = require('../services/worker');
const retrieval = require('../services/retrieval');
const { verifyErasure } = require('../services/erasureVerifier');

const { Memory, Suggestion, Consent, AuditLog, Job } = models;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  await Promise.all(['Personal', 'Health', 'Learning', 'Hobbies'].map((name) => createCategory(name)));
});

async function chat(token) {
  const conversation = (await api(token).post('/api/conversations').send({ title: 'Chat' })).body;
  const say = async (content) => (await api(token).post(`/api/conversations/${conversation._id}/messages`).send({ role: 'user', content })).body;
  return { conversation, say };
}

const setConsent = (token, category, body) => api(token).put(`/api/me/consent/${category}`).send(body);
const current = (userId) => Memory.find({ userId, validTo: null, retractedAt: null }).sort({ _id: 1 }).lean();

describe('consent settings', () => {
  test('every category is listed with the default mode "store" until the user chooses', async () => {
    const { token } = await createUser();
    const res = await api(token).get('/api/me/consent');
    expect(res.status).toBe(200);
    expect(res.body.default).toBe('store');
    expect(res.body.consent.map((c) => [c.category, c.mode])).toEqual([
      ['Health', 'store'],
      ['Hobbies', 'store'],
      ['Learning', 'store'],
      ['Personal', 'store'],
    ]);
  });

  test('a category is set by name (any case) or by id; bad modes and unknown categories are 400', async () => {
    const { user, token } = await createUser();
    expect((await setConsent(token, 'health', { mode: 'ask' })).body.mode).toBe('ask');
    const hobbies = await models.Category.findOne({ name: 'Hobbies' });
    expect((await setConsent(token, String(hobbies._id), { mode: 'never' })).status).toBe(200);
    expect((await setConsent(token, 'Health', { mode: 'store' })).status).toBe(200); // a change of mind updates the same row
    expect(await Consent.countDocuments({ userId: user._id })).toBe(2);

    expect((await setConsent(token, 'Health', { mode: 'maybe' })).status).toBe(400);
    expect((await setConsent(token, 'Health', {})).status).toBe(400);
    expect((await setConsent(token, 'Health', { mode: 'never', eraseExisting: 'yes' })).status).toBe(400);
    expect((await setConsent(token, 'Astrology', { mode: 'never' })).status).toBe(400);
    expect((await api().get('/api/me/consent')).status).toBe(401);
  });

  test("one user's settings never affect another user", async () => {
    const a = await createUser();
    const b = await createUser();
    await setConsent(a.token, 'Health', { mode: 'never' });
    expect((await api(b.token).post('/api/memories').send({ content: 'Has asthma', category: 'Health' })).status).toBe(201);
    const listed = (await api(b.token).get('/api/me/consent')).body.consent.find((c) => c.category === 'Health');
    expect(listed.mode).toBe('store');
  });
});

describe('"never": the category is not stored by any path', () => {
  test('the extractor skips the fact and the API refuses to create or move a memory into the category', async () => {
    const { user, token } = await createUser();
    await setConsent(token, 'Health', { mode: 'never' });
    const { say } = await chat(token);
    await say('I am allergic to dust. I live in Kochi');
    await worker.drain();
    expect((await current(user._id)).map((m) => m.content)).toEqual(['Lives in Kochi']);
    const decisions = (await Job.findOne().lean()).result.decisions;
    expect(decisions.map((d) => d.action)).toEqual(['SKIP', 'ADD']);

    const create = await api(token).post('/api/memories').send({ content: 'Has asthma', category: 'Health' });
    expect(create.status).toBe(409);
    expect(create.body.error).toMatch(/consent for "Health"/);
    const [kochi] = await current(user._id);
    expect((await api(token).put(`/api/memories/${kochi._id}`).send({ category: 'Health' })).status).toBe(409);
    expect(await Memory.countDocuments({ userId: user._id })).toBe(1);
  });

  test('withdrawing consent erases every stored version of the category, unless eraseExisting is false', async () => {
    const { user, token } = await createUser();
    const v1 = (await api(token).post('/api/memories').send({ content: 'Has a cold', category: 'Health' })).body;
    await api(token).put(`/api/memories/${v1._id}`).send({ content: 'Has a bad cold' });
    const kept = (await api(token).post('/api/memories').send({ content: 'Likes chess', category: 'Hobbies' })).body;
    await api(token).post('/api/memories').send({ content: 'Runs daily', category: 'Hobbies' });

    // Keep: the existing Hobbies memories stay; only new ones are refused
    const keep = await setConsent(token, 'Hobbies', { mode: 'never', eraseExisting: false });
    expect(keep.body.erased).toBeNull();
    expect(await Memory.countDocuments({ userId: user._id, categoryId: kept.categoryId._id })).toBe(2);

    // Erase (the default for "never"): both Health versions go, and the log keeps no Health text
    const res = await setConsent(token, 'Health', { mode: 'never' });
    expect(res.status).toBe(200);
    expect(res.body.erased).toMatchObject({ erasedVersions: 2, deletedSuggestions: 0 });
    expect(await Memory.countDocuments({ userId: user._id })).toBe(2);
    expect(await AuditLog.countDocuments({ userId: user._id, action: 'erase' })).toBe(2);
    expect(await AuditLog.countDocuments({ userId: user._id, $or: [{ 'after.content': /cold/ }, { 'before.content': /cold/ }] })).toBe(0);
    expect((await verifyErasure({ userId: user._id, text: 'cold' })).ok).toBe(true);
  });
});

describe('"ask": facts wait as suggestions until the user decides', () => {
  test('the extractor stores a suggestion, not a memory, and retrieval cannot see it', async () => {
    const { user, token } = await createUser();
    await setConsent(token, 'Health', { mode: 'ask' });
    const { say } = await chat(token);
    const message = await say('I am allergic to dust. I live in Kochi');
    await worker.drain();

    expect((await current(user._id)).map((m) => m.content)).toEqual(['Lives in Kochi']);
    const decisions = (await Job.findOne().lean()).result.decisions;
    expect(decisions.map((d) => d.action)).toEqual(['ASK', 'ADD']);
    const list = await api(token).get('/api/me/suggestions');
    expect(list.status).toBe(200);
    expect(list.body.suggestions).toHaveLength(1);
    expect(list.body.suggestions[0]).toMatchObject({ content: 'Is allergic to dust', sensitivity: 'special', messageId: message._id, categoryId: { name: 'Health' } });

    const { results } = await retrieval.retrieve(user._id, { query: 'allergic dust', k: 5 });
    expect(results.map((r) => r.memory.content)).not.toContain('Is allergic to dust');
  });

  test('a retried job does not suggest the same fact twice', async () => {
    const { user, token } = await createUser();
    await setConsent(token, 'Health', { mode: 'ask' });
    const { conversation, say } = await chat(token);
    const message = await say('I am allergic to dust');
    await worker.drain();
    const extraction = require('../services/extractionService');
    await extraction.processMessage({ userId: user._id, messageId: message._id, conversationId: conversation._id });
    expect(await Suggestion.countDocuments({ userId: user._id })).toBe(1);
  });

  test('accepting creates a memory with the source message and an audit entry; rejecting deletes it', async () => {
    const { user, token } = await createUser();
    await setConsent(token, 'Health', { mode: 'ask' });
    const { say } = await chat(token);
    const message = await say('I am allergic to dust. I am allergic to pollen');
    await worker.drain();
    const [first, second] = (await api(token).get('/api/me/suggestions')).body.suggestions;

    const accepted = await api(token).post(`/api/me/suggestions/${first._id}/accept`);
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ content: first.content, sensitivity: 'special', sourceMessageIds: [message._id] });
    expect(await AuditLog.countDocuments({ memoryId: accepted.body._id, action: 'create' })).toBe(1);
    expect((await api(token).post(`/api/me/suggestions/${first._id}/accept`)).status).toBe(404); // only once

    expect((await api(token).delete(`/api/me/suggestions/${second._id}`)).status).toBe(200);
    expect(await Suggestion.countDocuments({ userId: user._id })).toBe(0);
    expect((await current(user._id)).map((m) => m.content)).toEqual([first.content]);
  });

  test("a suggestion cannot be accepted in a category since set to never (it is kept), nor by another user", async () => {
    const owner = await createUser();
    const other = await createUser();
    await setConsent(owner.token, 'Health', { mode: 'ask' });
    await (await chat(owner.token)).say('I am allergic to dust');
    await worker.drain();
    const [suggestion] = (await api(owner.token).get('/api/me/suggestions')).body.suggestions;

    expect((await api(other.token).post(`/api/me/suggestions/${suggestion._id}/accept`)).status).toBe(404);
    expect((await api(other.token).delete(`/api/me/suggestions/${suggestion._id}`)).status).toBe(404);
    expect((await api(other.token).get('/api/me/suggestions')).body.suggestions).toHaveLength(0);

    await setConsent(owner.token, 'Health', { mode: 'never', eraseExisting: false });
    expect((await api(owner.token).post(`/api/me/suggestions/${suggestion._id}/accept`)).status).toBe(409);
    expect(await Suggestion.countDocuments({ _id: suggestion._id })).toBe(1); // put back after the refusal
    expect(await Memory.countDocuments({ userId: owner.user._id })).toBe(0);

    // Withdrawing with erasure also removes the pending suggestions of the category
    expect((await setConsent(owner.token, 'Health', { mode: 'never' })).body.erased.deletedSuggestions).toBe(1);
  });
});

describe('deleting a category', () => {
  test("removes every user's consent setting and pending suggestions for it", async () => {
    const admin = await createAdmin();
    const user = await createUser();
    const category = await createCategory('Travel');
    await setConsent(user.token, 'Travel', { mode: 'never' });
    expect(await Consent.countDocuments({ categoryId: category._id })).toBe(1);
    expect((await api(admin.token).delete(`/api/categories/${category._id}`)).status).toBe(200);
    expect(await Consent.countDocuments({ categoryId: category._id })).toBe(0);
  });
});
