// Stage 7: lineage-based hard erasure (deleting a message or conversation) and its verification
const path = require('path');
const { execFile } = require('child_process');
const { connect, disconnect, clear, api, createUser, createCategory, models } = require('./helpers');
const worker = require('../services/worker');
const auditService = require('../services/auditService');
const { verifyErasure } = require('../services/erasureVerifier');

const { Memory, Message, AuditLog, Job, Suggestion, EvalItem } = models;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  await Promise.all(['Personal', 'Health', 'Learning', 'Hobbies'].map((name) => createCategory(name)));
});
afterEach(() => jest.restoreAllMocks());

async function chat(token) {
  const conversation = (await api(token).post('/api/conversations').send({ title: 'Chat' })).body;
  const say = async (content) => (await api(token).post(`/api/conversations/${conversation._id}/messages`).send({ role: 'user', content })).body;
  const erase = (message) => api(token).delete(`/api/conversations/${conversation._id}/messages/${message._id}`);
  return { conversation, say, erase };
}

const current = (userId) => Memory.find({ userId, validTo: null, retractedAt: null }).sort({ _id: 1 }).lean();
const expectClean = async (options) => {
  const report = await verifyErasure(options);
  expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  expect(report.ok).toBe(true);
};

describe('deleting a message erases what was derived only from it', () => {
  test('the memory, its embedding, its job and the audit content are gone; the log keeps an "erase" entry', async () => {
    const { user, token } = await createUser();
    const { say, erase } = await chat(token);
    const keep = await say('I live in Kochi');
    const secret = await say('I am allergic to penicillin');
    await worker.drain();
    const derived = await Memory.findOne({ userId: user._id, sourceMessageIds: secret._id }).select('+embedding').lean();
    expect(derived.embedding.length).toBeGreaterThan(0);

    const res = await erase(secret);
    expect(res.status).toBe(200);
    expect(res.body.erasure).toMatchObject({ erasedVersions: 1, restoredVersions: 0, flaggedVersions: 0, deletedJobs: 1 });
    expect(await Message.countDocuments({ _id: secret._id })).toBe(0);
    expect(await Memory.countDocuments({ _id: derived._id })).toBe(0);
    expect((await current(user._id)).map((m) => m.content)).toEqual(['Lives in Kochi']);
    expect(await Job.countDocuments({ 'payload.messageId': secret._id })).toBe(0);

    // The "create" entry is tombstoned: it still says a memory was created then, but not what it said
    const created = await AuditLog.findOne({ memoryId: derived._id, action: 'create' }).lean();
    expect(created).toMatchObject({ before: null, after: null, reason: null });
    expect(created.tombstonedAt).toBeInstanceOf(Date);
    expect(await AuditLog.findOne({ memoryId: derived._id, action: 'erase' }).lean()).toMatchObject({ before: null, after: null, reason: 'message deleted' });

    await expectClean({ userId: user._id, messageIds: [secret._id], text: 'penicillin' });
    expect(await Message.countDocuments({ _id: keep._id })).toBe(1);
  });

  test('erasing the message that superseded a fact restores the old version as current', async () => {
    const { user, token } = await createUser();
    const { say, erase } = await chat(token);
    await say('I live in Pune since 2020');
    await worker.drain();
    const moved = await say('Big news: I moved to Mumbai in March 2024');
    await worker.drain();

    const res = await erase(moved);
    expect(res.body.erasure).toMatchObject({ erasedVersions: 1, restoredVersions: 1 });
    const [pune] = await current(user._id);
    expect(pune).toMatchObject({ content: 'Lives in Pune', validTo: null, closedAt: null, supersededBy: null });
    expect(pune.erasureReview.reason).toMatch(/restored/);
    expect(await AuditLog.countDocuments({ memoryId: pune._id, action: 'restore' })).toBe(1);
    // As if the move had never been mentioned: today the user lives in Pune
    expect((await api(token).get('/api/memories?asOf=2025-01-01')).body.memories.map((m) => m.content)).toEqual(['Lives in Pune']);
    expect((await api(token).get('/api/memories?needsReview=true')).body.memories.map((m) => m.content)).toEqual(['Lives in Pune']);
    await expectClean({ userId: user._id, messageIds: [moved._id], text: 'Mumbai' });
  });

  test('erasing the first message of a chain keeps the later version and unlinks it', async () => {
    const { user, token } = await createUser();
    const { say, erase } = await chat(token);
    const first = await say('I live in Pune since 2020');
    await worker.drain();
    await say('Big news: I moved to Mumbai in March 2024');
    await worker.drain();

    expect((await erase(first)).body.erasure).toMatchObject({ erasedVersions: 1, restoredVersions: 0 });
    const all = await Memory.find({ userId: user._id }).lean();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ content: 'Lives in Mumbai', supersedes: null, validTo: null });
    expect((await api(token).get(`/api/memories/${all[0]._id}/history`)).body.count).toBe(1);
    await expectClean({ userId: user._id, text: 'Pune' });
  });

  test('a version with another surviving source is kept, loses the erased source and is flagged for review', async () => {
    const { user, token } = await createUser();
    const { say, erase } = await chat(token);
    const first = await say('I love coffee');
    await worker.drain();
    const second = await say('Honestly I love black coffee');
    await worker.drain();
    const [latest] = await current(user._id);
    expect(latest.sourceMessageIds.map(String)).toEqual([first._id, second._id]);

    const res = await erase(second);
    expect(res.body.erasure).toMatchObject({ erasedVersions: 0, flaggedVersions: 1 });
    const kept = await Memory.findById(latest._id).lean();
    expect(kept.sourceMessageIds.map(String)).toEqual([first._id]);
    expect(kept.erasureReview.reason).toMatch(/source messages were erased/);
    // The log keeps no reference to the erased message
    expect(await AuditLog.countDocuments({ 'after.sourceMessageIds': second._id })).toBe(0);
    await expectClean({ userId: user._id, messageIds: [second._id] });
  });

  test('a correction erased with its message un-retracts the version it corrected', async () => {
    const { user, token } = await createUser();
    const { say, erase } = await chat(token);
    const m1 = await say('note one');
    const m2 = await say('note two');
    await worker.drain();
    const v1 = (await api(token).post('/api/memories').send({ content: 'Works at TCS', category: 'Personal', sourceMessageIds: [m1._id] })).body;
    await api(token).put(`/api/memories/${v1._id}`).send({ content: 'Works at Infosys', correction: true, sourceMessageIds: [m2._id] });
    expect((await Memory.findById(v1._id).lean()).retractedAt).not.toBeNull();

    expect((await erase(m2)).body.erasure).toMatchObject({ erasedVersions: 1, restoredVersions: 1 });
    const restored = await Memory.findById(v1._id).lean();
    expect(restored).toMatchObject({ retractedAt: null, supersededBy: null, content: 'Works at TCS' });
    await expectClean({ userId: user._id, text: 'Infosys' });
  });

  test('a version the user deleted (retracted) is not brought back; the older version stays closed and is flagged', async () => {
    const { user, token } = await createUser();
    const { say, erase } = await chat(token);
    const m1 = await say('note one');
    const m2 = await say('note two');
    await worker.drain();
    const v1 = (await api(token).post('/api/memories').send({ content: 'Lives in Pune', category: 'Personal', sourceMessageIds: [m1._id] })).body;
    const v2 = (await api(token).put(`/api/memories/${v1._id}`).send({ content: 'Lives in Goa', sourceMessageIds: [m2._id] })).body;
    await api(token).delete(`/api/memories/${v2._id}`); // the user retracts the current fact

    expect((await erase(m2)).body.erasure).toMatchObject({ erasedVersions: 1, restoredVersions: 0 });
    const old = await Memory.findById(v1._id).lean();
    expect(old.validTo).not.toBeNull();
    expect(old.supersededBy).toBeNull();
    expect(old.erasureReview.reason).toBe('a later version was erased');
    expect(await current(user._id)).toHaveLength(0);
    await expectClean({ userId: user._id });
  });

  test('pending suggestions and benchmark evidence pointing at the message go too', async () => {
    const { user, token } = await createUser();
    await api(token).put('/api/me/consent/Health').send({ mode: 'ask' });
    const { say, erase } = await chat(token);
    const message = await say('I am allergic to dust');
    await worker.drain();
    await EvalItem.create({ dataset: 'benchmark', source: { name: 'locomo', id: 't', index: 0 }, userId: user._id, question: 'q', category: 1, questionType: 'single-hop', evidenceMessageIds: [message._id] });
    expect(await Suggestion.countDocuments({ messageId: message._id })).toBe(1);

    expect((await erase(message)).body.erasure).toMatchObject({ deletedSuggestions: 1 });
    expect(await Suggestion.countDocuments()).toBe(0);
    expect((await EvalItem.findOne().lean()).evidenceMessageIds).toEqual([]);
    await expectClean({ userId: user._id, messageIds: [message._id], text: 'dust' });
  });

  test("another user's message is a 404 and nothing of theirs changes; a bad id is a 400", async () => {
    const owner = await createUser();
    const other = await createUser();
    const { conversation, say } = await chat(owner.token);
    const message = await say('I live in Kochi');
    await worker.drain();
    expect((await api(other.token).delete(`/api/conversations/${conversation._id}/messages/${message._id}`)).status).toBe(404);
    const otherChat = await chat(other.token);
    expect((await api(other.token).delete(`/api/conversations/${otherChat.conversation._id}/messages/${message._id}`)).status).toBe(404);
    expect((await api(owner.token).delete(`/api/conversations/${conversation._id}/messages/nope`)).status).toBe(400);
    expect(await Memory.countDocuments({ userId: owner.user._id })).toBe(1);
  });

  test('the erasure is one transaction: if any step fails, nothing is erased', async () => {
    const { user, token } = await createUser();
    const { say, erase } = await chat(token);
    const message = await say('I am allergic to penicillin');
    await worker.drain();
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('disk full'));
    expect((await erase(message)).status).toBe(500);
    expect(await Message.countDocuments({ _id: message._id })).toBe(1);
    expect(await Memory.countDocuments({ userId: user._id })).toBe(1);
    expect(await AuditLog.countDocuments({ tombstonedAt: { $ne: null } })).toBe(0);
  });
});

describe('deleting a conversation', () => {
  test('erases every memory derived from it, keeps memories from other conversations, and verifies clean', async () => {
    const { user, token } = await createUser();
    const a = await chat(token);
    const b = await chat(token);
    await a.say('I live in Pune since 2020');
    await worker.drain();
    await a.say('I am allergic to dust');
    await b.say('I work at Infosys');
    await worker.drain();
    expect(await Memory.countDocuments({ userId: user._id })).toBe(3);

    const res = await api(token).delete(`/api/conversations/${a.conversation._id}`);
    expect(res.status).toBe(200);
    expect(res.body.erasure).toMatchObject({ erasedVersions: 2 });
    expect((await current(user._id)).map((m) => m.content)).toEqual(['Works at Infosys']);
    await expectClean({ userId: user._id, text: 'dust' });
  });
});

describe('the verifier', () => {
  test('detects leftovers: a dangling source, a dangling chain link and an audit snapshot of a missing version', async () => {
    const { user, token } = await createUser();
    const m = (await api(token).post('/api/memories').send({ content: 'Likes tea', category: 'Personal' })).body;
    await expectClean({ userId: user._id });

    // Simulate a buggy erasure that deleted rows directly, without the erasure service
    const ghost = new Memory.base.Types.ObjectId();
    await Memory.collection.updateOne({ _id: new Memory.base.Types.ObjectId(m._id) }, { $set: { sourceMessageIds: [ghost], supersedes: ghost } });
    await Memory.collection.insertOne({ userId: user._id, content: 'x', categoryId: m.categoryId._id, validFrom: new Date(), recordedAt: new Date(), validTo: null, retractedAt: null });
    const orphan = await Memory.findOne({ content: 'x' }).lean();
    await auditService.record({ userId: user._id, memoryId: orphan._id, action: 'create', after: orphan });
    await Memory.collection.deleteOne({ _id: orphan._id });

    const report = await verifyErasure({ userId: user._id, messageIds: [ghost], text: 'tea' });
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.check);
    expect(failed).toEqual(
      expect.arrayContaining([
        'memories.sourceMessageIds -> existing messages',
        'memories.supersedes -> existing versions',
        'auditlog entries with content -> existing versions (memoryId)',
        'erased message ids are referenced nowhere',
        'no stored memory text contains "tea"',
      ])
    );
    // The endpoint runs the same checks for the signed-in user
    const res = await api(token).get('/api/me/erasure-check');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });

  test('"npm run erasure:verify" exits 0 on a clean database and 1 when a check fails', async () => {
    const run = (args) =>
      new Promise((resolve) => {
        execFile('node', [path.join(__dirname, '..', 'scripts', 'verify-erasure.js'), ...args], { env: { ...process.env, MONGO_URI: process.env.MONGO_URI_TEST } }, (err, stdout) =>
          resolve({ code: err ? err.code : 0, stdout })
        );
      });
    const { token } = await createUser();
    await api(token).post('/api/memories').send({ content: 'Likes tea', category: 'Personal' });
    const clean = await run([]);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toMatch(/OK: nothing derived from erased data remains/);
    const dirty = await run(['--text', 'tea']);
    expect(dirty.code).toBe(1);
    expect(dirty.stdout).toMatch(/FAIL/);
  });
});
