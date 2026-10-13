const { connect, disconnect, clear, api, createUser, createCategory, models } = require('./helpers');
const auditService = require('../services/auditService');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);
afterEach(() => jest.restoreAllMocks());

const OBJECT_ID_NOT_IN_DB = '507f1f77bcf86cd799439011';
// A few milliseconds between steps, so "known at" instants fall strictly between two writes
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

async function setup() {
  const user = await createUser();
  await createCategory('Health');
  await createCategory('Personal');
  await createCategory('Learning');
  return user;
}

const contents = (res) => res.body.memories.map((m) => m.content).sort();

describe('new fields on create', () => {
  test('a new memory is a current first version with server-set transaction time', async () => {
    const { token } = await setup();
    const before = Date.now();
    const res = await api(token).post('/api/memories').send({ content: 'Learning SQL', category: 'Learning', recordedAt: '2000-01-01T00:00:00Z' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ validTo: null, retractedAt: null, closedAt: null, supersedes: null, supersededBy: null, confidence: 1, sensitivity: 'normal', accessCount: 0, sourceMessageIds: [] });
    // recordedAt comes from the server clock, never from the request
    expect(Date.parse(res.body.recordedAt)).toBeGreaterThanOrEqual(before);
    expect(res.body.validFrom).toBe(res.body.recordedAt);
  });

  test('health facts default to sensitivity "special"; an explicit value wins; bad values are 400', async () => {
    const { token } = await setup();
    expect((await api(token).post('/api/memories').send({ content: 'Asthma', category: 'health' })).body.sensitivity).toBe('special');
    expect((await api(token).post('/api/memories').send({ content: 'Sister lives in Goa', category: 'Personal', sensitivity: 'personal' })).body.sensitivity).toBe('personal');
    expect((await api(token).post('/api/memories').send({ content: 'x', category: 'Personal', sensitivity: 'secret' })).status).toBe(400);
  });

  test('confidence must be a number from 0 to 1', async () => {
    const { token } = await setup();
    expect((await api(token).post('/api/memories').send({ content: 'x', category: 'Personal', confidence: 0.6 })).body.confidence).toBe(0.6);
    for (const confidence of [1.5, -0.1, '0.5']) {
      expect((await api(token).post('/api/memories').send({ content: 'x', category: 'Personal', confidence })).status).toBe(400);
    }
  });

  test('validFrom can be in the past (backdated fact) but not in the future, and must be a date', async () => {
    const { token } = await setup();
    const res = await api(token).post('/api/memories').send({ content: 'Lives in Pune', category: 'Personal', validFrom: '2020-01-01' });
    expect(res.body.validFrom).toBe('2020-01-01T00:00:00.000Z');
    expect(Date.parse(res.body.recordedAt)).toBeGreaterThan(Date.parse(res.body.validFrom));
    expect((await api(token).post('/api/memories').send({ content: 'x', category: 'Personal', validFrom: '2999-01-01' })).status).toBe(400);
    expect((await api(token).post('/api/memories').send({ content: 'x', category: 'Personal', validFrom: 'yesterday' })).status).toBe(400);
  });

  test('sourceMessageIds must be messages in my own conversations', async () => {
    const { token } = await setup();
    const other = await createUser();
    const mine = (await api(token).post('/api/conversations').send({ title: 'Mine' })).body;
    const theirs = (await api(other.token).post('/api/conversations').send({ title: 'Theirs' })).body;
    const myMessage = (await api(token).post(`/api/conversations/${mine._id}/messages`).send({ role: 'user', content: 'I moved to Pune' })).body;
    const theirMessage = (await api(other.token).post(`/api/conversations/${theirs._id}/messages`).send({ role: 'user', content: 'secret' })).body;

    const ok = await api(token).post('/api/memories').send({ content: 'Lives in Pune', category: 'Personal', sourceMessageIds: [myMessage._id, myMessage._id] });
    expect(ok.status).toBe(201);
    expect(ok.body.sourceMessageIds).toEqual([myMessage._id]);
    expect((await api(token).post('/api/memories').send({ content: 'x', category: 'Personal', sourceMessageIds: [theirMessage._id] })).status).toBe(400);
    expect((await api(token).post('/api/memories').send({ content: 'x', category: 'Personal', sourceMessageIds: [OBJECT_ID_NOT_IN_DB] })).status).toBe(400);
    expect((await api(token).post('/api/memories').send({ content: 'x', category: 'Personal', sourceMessageIds: 'abc' })).status).toBe(400);
  });
});

describe('supersede', () => {
  test('an update closes the old version and inserts a new one; the old content is never overwritten', async () => {
    const { token } = await setup();
    const v1 = (await api(token).post('/api/memories').send({ content: 'Lives in Delhi', category: 'Personal', importance: 4, tags: ['city'] })).body;
    await tick();
    const res = await api(token).put(`/api/memories/${v1._id}`).send({ content: 'Lives in Pune' });
    expect(res.status).toBe(200);
    const v2 = res.body;

    expect(v2._id).not.toBe(v1._id);
    // Unchanged fields are carried over to the new version
    expect(v2).toMatchObject({ content: 'Lives in Pune', importance: 4, tags: ['city'], supersedes: v1._id, supersededBy: null, validTo: null, retractedAt: null });
    expect(Date.parse(v2.validFrom)).toBeGreaterThan(Date.parse(v1.validFrom));

    const old = await models.Memory.findById(v1._id).lean();
    expect(old.content).toBe('Lives in Delhi');
    expect(String(old.supersededBy)).toBe(v2._id);
    expect(old.validTo.toISOString()).toBe(v2.validFrom); // valid intervals meet with no gap and no overlap
    expect(old.closedAt.toISOString()).toBe(v2.recordedAt);
    expect(old.retractedAt).toBeNull(); // still believed: it WAS true until validTo

    const list = await api(token).get('/api/memories');
    expect(contents(list)).toEqual(['Lives in Pune']);
  });

  test('the date of the change can be given (validFrom), and must fall after the old version started', async () => {
    const { token } = await setup();
    const v1 = (await api(token).post('/api/memories').send({ content: 'Lives in Delhi', category: 'Personal', validFrom: '2020-01-01' })).body;
    expect((await api(token).put(`/api/memories/${v1._id}`).send({ content: 'Lives in Pune', validFrom: '2019-06-01' })).status).toBe(400);
    expect((await api(token).put(`/api/memories/${v1._id}`).send({ content: 'Lives in Pune', validFrom: '2999-01-01' })).status).toBe(400);
    const v2 = (await api(token).put(`/api/memories/${v1._id}`).send({ content: 'Lives in Pune', validFrom: '2024-06-01' })).body;
    expect(v2.validFrom).toBe('2024-06-01T00:00:00.000Z');
    expect((await models.Memory.findById(v1._id)).validTo.toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  test('only the current version can be updated: an old one is a 409 naming its successor', async () => {
    const { token } = await setup();
    const v1 = (await api(token).post('/api/memories').send({ content: 'a', category: 'Personal' })).body;
    const v2 = (await api(token).put(`/api/memories/${v1._id}`).send({ content: 'b' })).body;
    const res = await api(token).put(`/api/memories/${v1._id}`).send({ content: 'c' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(v2._id);
    expect(await models.Memory.countDocuments()).toBe(2);
  });

  test('two concurrent updates of the same version: exactly one wins, the chain never forks', async () => {
    const { token } = await setup();
    const v1 = (await api(token).post('/api/memories').send({ content: 'a', category: 'Personal' })).body;
    const results = await Promise.all([
      api(token).put(`/api/memories/${v1._id}`).send({ content: 'b' }),
      api(token).put(`/api/memories/${v1._id}`).send({ content: 'c' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await models.Memory.countDocuments({ supersedes: v1._id })).toBe(1);
    expect(await models.Memory.countDocuments({ validTo: null, retractedAt: null })).toBe(1);
  });

  test('moving a memory into Health makes the new version "special"', async () => {
    const { token } = await setup();
    const v1 = (await api(token).post('/api/memories').send({ content: 'Runs 5k daily', category: 'Personal' })).body;
    const v2 = (await api(token).put(`/api/memories/${v1._id}`).send({ category: 'Health' })).body;
    expect(v2.sensitivity).toBe('special');
  });
});

describe('correction', () => {
  test('a correction retracts the wrong version and gives the new one the same valid time', async () => {
    const { token } = await setup();
    const v1 = (await api(token).post('/api/memories').send({ content: 'Exam on 12 May', category: 'Learning', validFrom: '2025-01-01' })).body;
    const v2 = (await api(token).put(`/api/memories/${v1._id}`).send({ content: 'Exam on 15 May', correction: true })).body;
    expect(v2).toMatchObject({ validFrom: '2025-01-01T00:00:00.000Z', supersedes: v1._id });
    const old = await models.Memory.findById(v1._id).lean();
    expect(old.retractedAt).not.toBeNull();
    expect(old.validTo).toBeNull(); // its valid time is not what changed; the belief was wrong
    expect(String(old.supersededBy)).toBe(v2._id);
    expect((await api(token).put(`/api/memories/${v2._id}`).send({ content: 'x', correction: 'yes' })).status).toBe(400);
    expect((await api(token).put(`/api/memories/${v2._id}`).send({ content: 'x', correction: true, validFrom: '2025-02-01' })).status).toBe(400);
  });
});

describe('retraction (delete)', () => {
  test('delete keeps the version with retractedAt; it disappears from current queries only', async () => {
    const { token } = await setup();
    const m = (await api(token).post('/api/memories').send({ content: 'Likes jazz', category: 'Personal' })).body;
    const res = await api(token).delete(`/api/memories/${m._id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted.retractedAt).not.toBeNull();
    expect(await models.Memory.countDocuments({ _id: m._id })).toBe(1);
    expect((await api(token).get('/api/memories')).body.count).toBe(0);
    expect((await api(token).get(`/api/memories/${m._id}`)).status).toBe(404);
    expect((await api(token).get(`/api/memories/${m._id}/history`)).body.versions[0].retractedAt).not.toBeNull();
  });
});

describe('history', () => {
  test('returns the whole chain oldest first from any version, and marks the current one', async () => {
    const { token } = await setup();
    const v1 = (await api(token).post('/api/memories').send({ content: 'Goal: MBA', category: 'Personal' })).body;
    await tick();
    const v2 = (await api(token).put(`/api/memories/${v1._id}`).send({ content: 'Goal: data analyst' })).body;
    await tick();
    const v3 = (await api(token).put(`/api/memories/${v2._id}`).send({ content: 'Goal: data engineer' })).body;
    await api(token).post('/api/memories').send({ content: 'unrelated', category: 'Personal' });

    for (const start of [v1, v2, v3]) {
      const res = await api(token).get(`/api/memories/${start._id}/history`);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(3);
      expect(res.body.versions.map((v) => v.content)).toEqual(['Goal: MBA', 'Goal: data analyst', 'Goal: data engineer']);
      expect(res.body.versions.map((v) => v.isCurrent)).toEqual([false, false, true]);
      expect(res.body.currentId).toBe(v3._id);
      expect(res.body.versions[0].categoryId.name).toBe('Personal');
    }
  });

  test("another user's memory has no visible history; bad ids are 400", async () => {
    const { token } = await setup();
    const other = await createUser();
    const m = (await api(token).post('/api/memories').send({ content: 'x', category: 'Personal' })).body;
    expect((await api(other.token).get(`/api/memories/${m._id}/history`)).status).toBe(404);
    expect((await api(token).get('/api/memories/nope/history')).status).toBe(400);
  });
});

describe('as-of queries: valid time (asOf) vs transaction time (knownAt)', () => {
  // The user lived in Delhi from 2020. On a later day they tell us they moved to Pune back in June 2024.
  async function cityStory(token) {
    const delhi = (await api(token).post('/api/memories').send({ content: 'Lives in Delhi', category: 'Personal', validFrom: '2020-01-01' })).body;
    await tick();
    const beforeMoveWasRecorded = new Date().toISOString();
    await tick();
    const pune = (await api(token).put(`/api/memories/${delhi._id}`).send({ content: 'Lives in Pune', validFrom: '2024-06-01' })).body;
    return { delhi, pune, beforeMoveWasRecorded };
  }

  test('asOf answers "what was true then?" with what we know now', async () => {
    const { token } = await setup();
    await cityStory(token);
    expect(contents(await api(token).get('/api/memories'))).toEqual(['Lives in Pune']);
    expect(contents(await api(token).get('/api/memories?asOf=2023-01-01'))).toEqual(['Lives in Delhi']);
    expect(contents(await api(token).get('/api/memories?asOf=2024-07-01'))).toEqual(['Lives in Pune']);
    expect(contents(await api(token).get('/api/memories?asOf=2019-01-01'))).toEqual([]);
    // validTo is exclusive: on the day of the move only the new city is valid
    expect(contents(await api(token).get('/api/memories?asOf=2024-06-01T00:00:00Z'))).toEqual(['Lives in Pune']);
  });

  test('knownAt answers "what did the database believe then?"', async () => {
    const { token } = await setup();
    const { beforeMoveWasRecorded, delhi } = await cityStory(token);
    expect(contents(await api(token).get(`/api/memories?knownAt=${beforeMoveWasRecorded}`))).toEqual(['Lives in Delhi']);
    // Before the first memory was recorded, the database knew nothing
    const createdAt = new Date(Date.parse(delhi.recordedAt) - 1).toISOString();
    expect(contents(await api(token).get(`/api/memories?knownAt=${createdAt}`))).toEqual([]);
  });

  test('asOf and knownAt together: in July 2024, we still believed the user lived in Delhi', async () => {
    const { token } = await setup();
    const { beforeMoveWasRecorded } = await cityStory(token);
    // Same valid time, two different transaction times, two different answers
    expect(contents(await api(token).get(`/api/memories?asOf=2024-07-01&knownAt=${beforeMoveWasRecorded}`))).toEqual(['Lives in Delhi']);
    expect(contents(await api(token).get(`/api/memories?asOf=2024-07-01&knownAt=${new Date().toISOString()}`))).toEqual(['Lives in Pune']);
  });

  test('a correction changes the knownAt answer but not the valid-time story', async () => {
    const { token } = await setup();
    const wrong = (await api(token).post('/api/memories').send({ content: 'Exam on 12 May', category: 'Learning', validFrom: '2025-01-01' })).body;
    await tick();
    const beforeCorrection = new Date().toISOString();
    await tick();
    await api(token).put(`/api/memories/${wrong._id}`).send({ content: 'Exam on 15 May', correction: true });

    expect(contents(await api(token).get('/api/memories?asOf=2025-02-01'))).toEqual(['Exam on 15 May']);
    expect(contents(await api(token).get(`/api/memories?knownAt=${beforeCorrection}`))).toEqual(['Exam on 12 May']);
    expect(contents(await api(token).get(`/api/memories?asOf=2025-02-01&knownAt=${beforeCorrection}`))).toEqual(['Exam on 12 May']);
  });

  test('a retracted memory is gone now but was believed before it was deleted', async () => {
    const { token } = await setup();
    const m = (await api(token).post('/api/memories').send({ content: 'Likes jazz', category: 'Personal' })).body;
    await tick();
    const beforeDelete = new Date().toISOString();
    await tick();
    await api(token).delete(`/api/memories/${m._id}`);
    expect(contents(await api(token).get('/api/memories'))).toEqual([]);
    expect(contents(await api(token).get(`/api/memories?asOf=${beforeDelete}`))).toEqual([]);
    expect(contents(await api(token).get(`/api/memories?knownAt=${beforeDelete}`))).toEqual(['Likes jazz']);
  });

  test('time travel stays scoped to the caller, combines with filters, and rejects bad dates', async () => {
    const { token } = await setup();
    const other = await createUser();
    await cityStory(token);
    await api(other.token).post('/api/memories').send({ content: 'Theirs', category: 'Personal', validFrom: '2020-01-01' });
    expect(contents(await api(token).get('/api/memories?asOf=2023-01-01'))).toEqual(['Lives in Delhi']);
    expect(contents(await api(token).get('/api/memories?asOf=2023-01-01&category=Learning'))).toEqual([]);
    const res = await api(token).get('/api/memories?asOf=2023-01-01');
    expect(res.body.asOf).toBe('2023-01-01T00:00:00.000Z');
    expect((await api(token).get('/api/memories?asOf=not-a-date')).status).toBe(400);
    expect((await api(token).get('/api/memories?knownAt=')).status).toBe(400);
  });
});

describe('current-state views ignore old versions', () => {
  test('stats and search count each memory once (its current version)', async () => {
    const { token } = await setup();
    const v1 = (await api(token).post('/api/memories').send({ content: 'learning german', category: 'Learning' })).body;
    await api(token).put(`/api/memories/${v1._id}`).send({ content: 'learning german B1' });
    const gone = (await api(token).post('/api/memories').send({ content: 'learning french', category: 'Learning' })).body;
    await api(token).delete(`/api/memories/${gone._id}`);
    await models.Memory.syncIndexes();

    const stats = (await api(token).get('/api/memories/stats/by-category')).body;
    expect(stats).toEqual([expect.objectContaining({ category: 'Learning', count: 1 })]);
    expect((await api(token).get('/api/memories/stats/status-ratio')).body.total).toBe(1);
    expect((await api(token).get('/api/memories/search?q=learning')).body.results.map((r) => r.content)).toEqual(['learning german B1']);
  });

  test('a category used by a past version cannot be deleted; one used only by retracted versions can', async () => {
    const admin = await createUser({ role: 'admin' });
    const a = await createCategory('A');
    await createCategory('B');
    const c = await createCategory('C');
    const v1 = (await api(admin.token).post('/api/memories').send({ content: 'x', category: 'A' })).body;
    await api(admin.token).put(`/api/memories/${v1._id}`).send({ category: 'B' }); // v1 (category A) is now a past version
    expect((await api(admin.token).delete(`/api/categories/${a._id}`)).status).toBe(409);

    const retracted = (await api(admin.token).post('/api/memories').send({ content: 'z', category: 'C' })).body;
    await api(admin.token).delete(`/api/memories/${retracted._id}`);
    expect((await api(admin.token).delete(`/api/categories/${c._id}`)).status).toBe(200);
  });
});

describe('usage tracking', () => {
  test('reading a memory counts an access without creating a version or touching updatedAt', async () => {
    const { token } = await setup();
    const m = (await api(token).post('/api/memories').send({ content: 'x', category: 'Personal' })).body;
    await tick();
    await api(token).get(`/api/memories/${m._id}`);
    const read = (await api(token).get(`/api/memories/${m._id}`)).body;
    expect(read.accessCount).toBe(2);
    expect(read.lastAccessedAt).not.toBeNull();
    expect(read.updatedAt).toBe(m.updatedAt);
    expect(await models.Memory.countDocuments()).toBe(1);
    // A new version carries the usage of the memory forward
    const v2 = (await api(token).put(`/api/memories/${m._id}`).send({ content: 'y' })).body;
    expect(v2.accessCount).toBe(2);
  });
});

describe('audit log', () => {
  test('create, supersede, correct and retract are each logged with before/after snapshots', async () => {
    const { user, token } = await setup();
    const v1 = (await api(token).post('/api/memories').send({ content: 'a', category: 'Personal' })).body;
    const v2 = (await api(token).put(`/api/memories/${v1._id}`).send({ content: 'b' })).body;
    const v3 = (await api(token).put(`/api/memories/${v2._id}`).send({ content: 'c', correction: true })).body;
    await api(token).delete(`/api/memories/${v3._id}`);

    const entries = await models.AuditLog.find({ userId: user._id }).sort({ _id: 1 }).lean();
    expect(entries.map((e) => e.action)).toEqual(['create', 'supersede', 'correct', 'retract']);
    expect(entries.every((e) => String(e.actorId) === String(user._id))).toBe(true);
    expect(entries[0].before).toBeNull();
    expect(entries[0].after.content).toBe('a');
    expect(entries[1]).toMatchObject({ before: expect.objectContaining({ content: 'a' }), after: expect.objectContaining({ content: 'b' }) });
    expect(String(entries[1].memoryId)).toBe(v2._id);
    expect(entries[3].after.retractedAt).toBeInstanceOf(Date);
  });

  test('GET /api/audit lists only my entries, newest first, and filters by memoryId', async () => {
    const { token } = await setup();
    const other = await createUser();
    const v1 = (await api(token).post('/api/memories').send({ content: 'a', category: 'Personal' })).body;
    const v2 = (await api(token).put(`/api/memories/${v1._id}`).send({ content: 'b' })).body;
    await api(other.token).post('/api/memories').send({ content: 'theirs', category: 'Personal' });

    const res = await api(token).get('/api/audit');
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e) => e.action)).toEqual(['supersede', 'create']);
    const one = await api(token).get(`/api/audit?memoryId=${v2._id}`);
    expect(one.body.entries.map((e) => e.action)).toEqual(['supersede']);
    expect((await api(token).get('/api/audit?memoryId=bad')).status).toBe(400);
    expect((await api().get('/api/audit')).status).toBe(401);
  });

  test('the audit log is append-only: updates and single deletes are refused', async () => {
    const { token } = await setup();
    await api(token).post('/api/memories').send({ content: 'a', category: 'Personal' });
    const entry = await models.AuditLog.findOne();
    await expect(models.AuditLog.updateOne({ _id: entry._id }, { action: 'retract' })).rejects.toThrow(/append-only/);
    await expect(models.AuditLog.findOneAndUpdate({ _id: entry._id }, { action: 'retract' })).rejects.toThrow(/append-only/);
    await expect(models.AuditLog.deleteOne({ _id: entry._id })).rejects.toThrow(/append-only/);
    await expect(entry.deleteOne()).rejects.toThrow(/append-only/);
    expect((await models.AuditLog.findById(entry._id)).action).toBe('create');
  });
});

describe('transactions: a failure part-way leaves no trace', () => {
  test('if the audit write fails during a supersede, the old version stays current and no new version exists', async () => {
    const { token } = await setup();
    const v1 = (await api(token).post('/api/memories').send({ content: 'Lives in Delhi', category: 'Personal' })).body;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('disk full'));

    const res = await api(token).put(`/api/memories/${v1._id}`).send({ content: 'Lives in Pune' });
    expect(res.status).toBe(500);

    const old = await models.Memory.findById(v1._id).lean();
    expect(old).toMatchObject({ validTo: null, closedAt: null, supersededBy: null, retractedAt: null });
    expect(await models.Memory.countDocuments()).toBe(1);
    expect(await models.AuditLog.countDocuments({ action: 'supersede' })).toBe(0);
    // ...and the same update succeeds once the fault is gone
    expect((await api(token).put(`/api/memories/${v1._id}`).send({ content: 'Lives in Pune' })).status).toBe(200);
  });

  test('if the audit write fails during a create or a retract, nothing is saved', async () => {
    const { token } = await setup();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('disk full'));
    expect((await api(token).post('/api/memories').send({ content: 'x', category: 'Personal' })).status).toBe(500);
    expect(await models.Memory.countDocuments()).toBe(0);

    const m = (await api(token).post('/api/memories').send({ content: 'y', category: 'Personal' })).body;
    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('disk full'));
    expect((await api(token).delete(`/api/memories/${m._id}`)).status).toBe(500);
    expect((await models.Memory.findById(m._id)).retractedAt).toBeNull();
  });
});

describe('deleting a conversation', () => {
  test('removes the deleted messages from sourceMessageIds of every version, so no reference dangles', async () => {
    const { token } = await setup();
    const conversation = (await api(token).post('/api/conversations').send({ title: 'Chat' })).body;
    const message = (await api(token).post(`/api/conversations/${conversation._id}/messages`).send({ role: 'user', content: 'I moved' })).body;
    const v1 = (await api(token).post('/api/memories').send({ content: 'a', category: 'Personal', sourceMessageIds: [message._id] })).body;
    await api(token).put(`/api/memories/${v1._id}`).send({ content: 'b' });
    expect((await api(token).delete(`/api/conversations/${conversation._id}`)).status).toBe(200);
    expect(await models.Memory.countDocuments({ sourceMessageIds: message._id })).toBe(0);
    expect(await models.Memory.countDocuments()).toBe(2);
  });
});
