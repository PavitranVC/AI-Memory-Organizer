const mongoose = require('mongoose');
const { connect, disconnect, clear, api, createUser, createCategory, models } = require('./helpers');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

const OBJECT_ID_NOT_IN_DB = '507f1f77bcf86cd799439011';

async function setup() {
  const user = await createUser();
  const health = await createCategory('Health');
  const learning = await createCategory('Learning');
  return { ...user, health, learning };
}

describe('memories CRUD', () => {
  test('create returns 201 with the category name and the caller as owner', async () => {
    const { user, token, health } = await setup();
    const res = await api(token).post('/api/memories').send({ content: 'Allergic to peanuts', category: 'Health', importance: 5, tags: ['Allergy', ' Food '] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ content: 'Allergic to peanuts', importance: 5, status: 'Active', tags: ['allergy', 'food'], userId: String(user._id) });
    expect(res.body.categoryId).toMatchObject({ _id: String(health._id), name: 'Health' });
  });

  test('create accepts categoryId instead of a name, and applies defaults', async () => {
    const { token, learning } = await setup();
    const res = await api(token).post('/api/memories').send({ content: 'Learn SQL', categoryId: String(learning._id) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ importance: 3, status: 'Active' });
  });

  test('read one, update (partial), delete', async () => {
    const { token } = await setup();
    const { body: created } = await api(token).post('/api/memories').send({ content: 'Original', category: 'Health' });

    const read = await api(token).get(`/api/memories/${created._id}`);
    expect(read.status).toBe(200);
    expect(read.body.content).toBe('Original');

    const updated = await api(token).put(`/api/memories/${created._id}`).send({ content: 'Changed', status: 'Archived', importance: 1, category: 'learning' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ content: 'Changed', importance: 1 });
    expect(updated.body.categoryId.name).toBe('Learning');

    // The update created a new version; deleting it retracts it, and a retracted version reads as 404
    expect(updated.body._id).not.toBe(created._id);
    expect((await api(token).delete(`/api/memories/${updated.body._id}`)).status).toBe(200);
    expect((await api(token).get(`/api/memories/${updated.body._id}`)).status).toBe(404);
    expect((await api(token).delete(`/api/memories/${updated.body._id}`)).status).toBe(404);
  });

  test('status can be changed to a valid value on update; anything else is rejected (filters are case-insensitive, writes are exact)', async () => {
    const { token } = await setup();
    const { body } = await api(token).post('/api/memories').send({ content: 'x', category: 'Health' });
    const res = await api(token).put(`/api/memories/${body._id}`).send({ status: 'Archived' });
    expect(res.body.status).toBe('Archived');
    // Every update creates a new version, so later updates go to the new (current) version's id
    expect((await api(token).put(`/api/memories/${res.body._id}`).send({ status: 'archived' })).status).toBe(400);
    expect((await api(token).put(`/api/memories/${res.body._id}`).send({ status: 'Deleted' })).status).toBe(400);
  });

  test('the owner and creation time cannot be changed through update', async () => {
    const a = await setup();
    const b = await createUser();
    const { body } = await api(a.token).post('/api/memories').send({ content: 'x', category: 'Health' });
    await api(a.token).put(`/api/memories/${body._id}`).send({ content: 'y', userId: String(b.user._id) });
    expect(String((await models.Memory.findById(body._id)).userId)).toBe(String(a.user._id));
  });
});

describe('memories validation', () => {
  test.each([
    ['missing content', { category: 'Health' }],
    ['empty content', { content: '   ', category: 'Health' }],
    ['content over 500 characters', { content: 'x'.repeat(501), category: 'Health' }],
    ['missing category', { content: 'x' }],
    ['importance 0', { content: 'x', category: 'Health', importance: 0 }],
    ['importance 6', { content: 'x', category: 'Health', importance: 6 }],
    ['importance 2.5', { content: 'x', category: 'Health', importance: 2.5 }],
    ['importance not a number', { content: 'x', category: 'Health', importance: 'high' }],
    ['status not allowed', { content: 'x', category: 'Health', status: 'Deleted' }],
    ['content is an object', { content: { $gt: '' }, category: 'Health' }],
    ['category is an object', { content: 'x', category: { $gt: '' } }],
  ])('create rejects %s with 400', async (label, body) => {
    const { token } = await setup();
    const res = await api(token).post('/api/memories').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(await models.Memory.countDocuments()).toBe(0);
  });

  test('update rejects invalid values and an empty body', async () => {
    const { token } = await setup();
    const { body } = await api(token).post('/api/memories').send({ content: 'x', category: 'Health' });
    expect((await api(token).put(`/api/memories/${body._id}`).send({ importance: 9 })).status).toBe(400);
    expect((await api(token).put(`/api/memories/${body._id}`).send({ content: 'x'.repeat(501) })).status).toBe(400);
    expect((await api(token).put(`/api/memories/${body._id}`).send({})).status).toBe(400);
  });

  test('malformed ids are 400 and unknown ids are 404', async () => {
    const { token } = await setup();
    expect((await api(token).get('/api/memories/not-an-id')).status).toBe(400);
    expect((await api(token).put('/api/memories/not-an-id').send({ content: 'x' })).status).toBe(400);
    expect((await api(token).delete('/api/memories/not-an-id')).status).toBe(400);
    expect((await api(token).get(`/api/memories/${OBJECT_ID_NOT_IN_DB}`)).status).toBe(404);
    expect((await api(token).put(`/api/memories/${OBJECT_ID_NOT_IN_DB}`).send({ content: 'x' })).status).toBe(404);
  });
});

describe('referential integrity', () => {
  test('create rejects an unknown category name and an unknown categoryId', async () => {
    const { token } = await setup();
    const byName = await api(token).post('/api/memories').send({ content: 'x', category: 'Nonexistent' });
    expect(byName.status).toBe(400);
    expect(byName.body.error).toMatch(/Unknown category/);
    const byId = await api(token).post('/api/memories').send({ content: 'x', categoryId: OBJECT_ID_NOT_IN_DB });
    expect(byId.status).toBe(400);
    expect(byId.body.error).toMatch(/Unknown categoryId/);
    expect((await api(token).post('/api/memories').send({ content: 'x', categoryId: 'garbage' })).status).toBe(400);
    expect(await models.Memory.countDocuments()).toBe(0);
  });

  test('update rejects an unknown category and leaves the memory unchanged', async () => {
    const { token } = await setup();
    const { body } = await api(token).post('/api/memories').send({ content: 'x', category: 'Health' });
    expect((await api(token).put(`/api/memories/${body._id}`).send({ categoryId: OBJECT_ID_NOT_IN_DB })).status).toBe(400);
    expect((await api(token).put(`/api/memories/${body._id}`).send({ category: 'Nope' })).status).toBe(400);
    expect(String((await models.Memory.findById(body._id)).categoryId)).toBe(String(body.categoryId._id));
  });

  test('create rejects a conversationId that does not exist', async () => {
    const { token } = await setup();
    const res = await api(token).post('/api/memories').send({ content: 'x', category: 'Health', conversationId: OBJECT_ID_NOT_IN_DB });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown conversationId/);
  });

  test("create and update reject another user's conversation", async () => {
    const a = await setup();
    const b = await createUser();
    const foreign = (await api(b.token).post('/api/conversations').send({ title: 'B chat' })).body;
    const create = await api(a.token).post('/api/memories').send({ content: 'x', category: 'Health', conversationId: foreign._id });
    expect(create.status).toBe(400);

    const { body } = await api(a.token).post('/api/memories').send({ content: 'x', category: 'Health' });
    expect((await api(a.token).put(`/api/memories/${body._id}`).send({ conversationId: foreign._id })).status).toBe(400);
  });

  test('update can link, validate and unlink a conversation', async () => {
    const { token } = await setup();
    const conversation = (await api(token).post('/api/conversations').send({ title: 'Chat' })).body;
    const { body } = await api(token).post('/api/memories').send({ content: 'x', category: 'Health' });

    const linked = await api(token).put(`/api/memories/${body._id}`).send({ conversationId: conversation._id });
    expect(linked.status).toBe(200);
    expect((await api(token).get(`/api/memories/${linked.body._id}`)).body.conversationId).toMatchObject({ title: 'Chat' });

    expect((await api(token).put(`/api/memories/${linked.body._id}`).send({ conversationId: OBJECT_ID_NOT_IN_DB })).status).toBe(400);

    const unlinked = await api(token).put(`/api/memories/${linked.body._id}`).send({ conversationId: null });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.conversationId).toBeNull();
  });
});

describe('scoping: every query is limited to the authenticated user', () => {
  async function twoUsers() {
    const a = await setup();
    const b = await createUser();
    const mine = (await api(a.token).post('/api/memories').send({ content: 'Alice peanuts allergy', category: 'Health', tags: ['peanut'] })).body;
    const theirs = (await api(b.token).post('/api/memories').send({ content: 'Bob peanuts allergy', category: 'Health', tags: ['peanut'] })).body;
    return { a, b, mine, theirs };
  }

  test('list returns only my memories', async () => {
    const { a, b, mine, theirs } = await twoUsers();
    const listA = await api(a.token).get('/api/memories');
    expect(listA.body.memories.map((m) => m._id)).toEqual([mine._id]);
    const listB = await api(b.token).get('/api/memories');
    expect(listB.body.memories.map((m) => m._id)).toEqual([theirs._id]);
  });

  test('a userId query parameter does not widen the scope', async () => {
    const { a, b, mine } = await twoUsers();
    const res = await api(a.token).get(`/api/memories?userId=${b.user._id}`);
    expect(res.body.memories.map((m) => m._id)).toEqual([mine._id]);
  });

  test("read, update and delete of someone else's memory is 404 and changes nothing", async () => {
    const { a, theirs } = await twoUsers();
    expect((await api(a.token).get(`/api/memories/${theirs._id}`)).status).toBe(404);
    expect((await api(a.token).put(`/api/memories/${theirs._id}`).send({ content: 'Hacked' })).status).toBe(404);
    expect((await api(a.token).delete(`/api/memories/${theirs._id}`)).status).toBe(404);
    expect((await models.Memory.findById(theirs._id)).content).toBe('Bob peanuts allergy');
  });

  test('search never returns another user\'s memories', async () => {
    const { a, mine } = await twoUsers();
    await models.Memory.syncIndexes();
    const res = await api(a.token).get('/api/memories/search?q=peanuts');
    expect(res.status).toBe(200);
    expect(res.body.results.map((m) => m._id)).toEqual([mine._id]);
  });

  test('both aggregations only count my memories', async () => {
    const { a } = await twoUsers();
    expect((await api(a.token).get('/api/memories/stats/status-ratio')).body.total).toBe(1);
    const byCategory = (await api(a.token).get('/api/memories/stats/by-category')).body;
    expect(byCategory).toEqual([expect.objectContaining({ category: 'Health', count: 1 })]);
  });

  test('a memory cannot be created for another user by passing their userId', async () => {
    const a = await setup();
    const b = await createUser();
    await api(a.token).post('/api/memories').send({ content: 'x', category: 'Health', userId: String(b.user._id) });
    expect(await models.Memory.countDocuments({ userId: b.user._id })).toBe(0);
    expect(await models.Memory.countDocuments({ userId: a.user._id })).toBe(1);
  });
});

describe('filters', () => {
  test('status, category and minImportance filters work and combine', async () => {
    const { token } = await setup();
    const make = (content, category, importance, status) => api(token).post('/api/memories').send({ content, category, importance, status });
    await make('h5 active', 'Health', 5, 'Active');
    await make('h2 active', 'Health', 2, 'Active');
    await make('h4 archived', 'Health', 4, 'Archived');
    await make('l3 active', 'Learning', 3, 'Active');

    const contents = async (qs) => (await api(token).get(`/api/memories?${qs}`)).body.memories.map((m) => m.content).sort();
    expect(await contents('status=active')).toEqual(['h2 active', 'h5 active', 'l3 active']);
    expect(await contents('status=ARCHIVED')).toEqual(['h4 archived']);
    expect(await contents('category=health')).toEqual(['h2 active', 'h4 archived', 'h5 active']);
    expect(await contents('minImportance=4')).toEqual(['h4 archived', 'h5 active']);
    expect(await contents('category=Health&status=Active&minImportance=3')).toEqual(['h5 active']);
  });

  test.each([
    ['status=Deleted'],
    ['status[$ne]=Active'],
    ['minImportance=abc'],
    ['minImportance=9'],
    ['minImportance=2.5'],
    ['category=Nonexistent'],
    ['categoryId=garbage'],
    ['limit=0'],
    ['limit=-1'],
    ['limit=abc'],
    ['limit=1&limit=2'],
    ['cursor=garbage'],
  ])('invalid query "%s" is a 400', async (qs) => {
    const { token } = await setup();
    expect((await api(token).get(`/api/memories?${qs}`)).status).toBe(400);
  });
});

describe('pagination', () => {
  async function seedMemories(token, n) {
    for (let i = 1; i <= n; i++) {
      await api(token).post('/api/memories').send({ content: `memory ${i}`, category: 'Health' });
    }
  }

  test('newest first, every memory exactly once, last page has a null cursor', async () => {
    const { token } = await setup();
    await seedMemories(token, 7);
    const seen = [];
    const pageSizes = [];
    let cursor;
    do {
      const res = await api(token).get(`/api/memories?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(3);
      pageSizes.push(res.body.count);
      seen.push(...res.body.memories.map((m) => m.content));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(pageSizes).toEqual([3, 3, 1]);
    expect(seen).toEqual(['memory 7', 'memory 6', 'memory 5', 'memory 4', 'memory 3', 'memory 2', 'memory 1']);
  });

  test('a page that ends exactly at the last item has no next cursor', async () => {
    const { token } = await setup();
    await seedMemories(token, 4);
    const res = await api(token).get('/api/memories?limit=4');
    expect(res.body.count).toBe(4);
    expect(res.body.nextCursor).toBeNull();
  });

  test('default limit is 20 and the maximum is 100', async () => {
    const { user, token, health } = await setup();
    await models.Memory.insertMany(Array.from({ length: 120 }, (_, i) => ({ userId: user._id, categoryId: health._id, content: `m${i}` })));
    const def = await api(token).get('/api/memories');
    expect(def.body.limit).toBe(20);
    expect(def.body.count).toBe(20);
    const capped = await api(token).get('/api/memories?limit=1000');
    expect(capped.status).toBe(200);
    expect(capped.body.limit).toBe(100);
    expect(capped.body.count).toBe(100);
    expect(capped.body.nextCursor).toBeTruthy();
  });

  test('a new memory added between pages does not shift or repeat items', async () => {
    const { token } = await setup();
    await seedMemories(token, 4);
    const first = await api(token).get('/api/memories?limit=2');
    await api(token).post('/api/memories').send({ content: 'late arrival', category: 'Health' });
    const second = await api(token).get(`/api/memories?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.memories.map((m) => m.content)).toEqual(['memory 2', 'memory 1']);
  });

  test('filters and pagination work together', async () => {
    const { token } = await setup();
    for (let i = 1; i <= 5; i++) {
      await api(token).post('/api/memories').send({ content: `h${i}`, category: 'Health' });
      await api(token).post('/api/memories').send({ content: `l${i}`, category: 'Learning' });
    }
    const page1 = await api(token).get('/api/memories?category=Health&limit=3');
    const page2 = await api(token).get(`/api/memories?category=Health&limit=3&cursor=${page1.body.nextCursor}`);
    expect([...page1.body.memories, ...page2.body.memories].map((m) => m.content)).toEqual(['h5', 'h4', 'h3', 'h2', 'h1']);
  });

  test('search takes a limit and caps it at 100', async () => {
    const { user, token, health } = await setup();
    await models.Memory.insertMany(Array.from({ length: 5 }, (_, i) => ({ userId: user._id, categoryId: health._id, content: `german lesson ${i}` })));
    await models.Memory.syncIndexes();
    expect((await api(token).get('/api/memories/search?q=german&limit=2')).body.results).toHaveLength(2);
    expect((await api(token).get('/api/memories/search?q=german&limit=5000')).body.limit).toBe(100);
  });
});

describe('aggregation: by category', () => {
  test('counts per category with the category name, active count and average importance', async () => {
    const { token } = await setup();
    const make = (category, importance, status) => api(token).post('/api/memories').send({ content: 'x', category, importance, status });
    await make('Health', 5, 'Active');
    await make('Health', 3, 'Archived');
    await make('Health', 4, 'Active');
    await make('Learning', 2, 'Active');

    const res = await api(token).get('/api/memories/stats/by-category');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ category: 'Health', count: 3, activeCount: 2, avgImportance: 4 }),
      expect.objectContaining({ category: 'Learning', count: 1, activeCount: 1, avgImportance: 2 }),
    ]);
  });

  test('a memory whose category document is missing is still counted, so the counts add up to the total', async () => {
    const { user, token, health } = await setup();
    await api(token).post('/api/memories').send({ content: 'normal', category: 'Health' });
    // Legacy data from before integrity checks: written straight to the collection with a category id that does not exist
    await models.Memory.collection.insertMany([
      { userId: user._id, categoryId: new mongoose.Types.ObjectId(), content: 'orphan 1', importance: 3, status: 'Active', tags: [] },
      { userId: user._id, categoryId: new mongoose.Types.ObjectId(), content: 'orphan 2', importance: 3, status: 'Archived', tags: [] },
    ]);
    expect(health).toBeTruthy();

    const res = await api(token).get('/api/memories/stats/by-category');
    const total = res.body.reduce((sum, row) => sum + row.count, 0);
    expect(total).toBe(3);
    expect(total).toBe((await api(token).get('/api/memories/stats/status-ratio')).body.total);
    expect(res.body.filter((row) => row.category === '(unknown category)')).toHaveLength(2);
  });

  test('returns an empty list for a user with no memories', async () => {
    const { token } = await setup();
    expect((await api(token).get('/api/memories/stats/by-category')).body).toEqual([]);
  });
});

describe('aggregation: status ratio', () => {
  test('active vs archived counts, percentages and ratio', async () => {
    const { token } = await setup();
    const make = (status) => api(token).post('/api/memories').send({ content: 'x', category: 'Health', status });
    for (const status of ['Active', 'Active', 'Active', 'Archived']) await make(status);
    const res = await api(token).get('/api/memories/stats/status-ratio');
    expect(res.body).toEqual({ total: 4, active: 3, archived: 1, ratio: '3:1', activePercent: 75, archivedPercent: 25, activeToArchived: 3 });
  });

  test('nothing archived gives a null active-to-archived ratio, no memories gives zeros', async () => {
    const { token } = await setup();
    expect((await api(token).get('/api/memories/stats/status-ratio')).body).toMatchObject({ total: 0, ratio: '0:0', activeToArchived: null });
    await api(token).post('/api/memories').send({ content: 'x', category: 'Health' });
    expect((await api(token).get('/api/memories/stats/status-ratio')).body).toMatchObject({ total: 1, archived: 0, activeToArchived: null, activePercent: 100 });
  });
});

describe('text search', () => {
  test('finds matches in content and tags, ranked by relevance', async () => {
    const { token } = await setup();
    await api(token).post('/api/memories').send({ content: 'Wants to learn German', category: 'Learning' });
    await api(token).post('/api/memories').send({ content: 'Practises on Duolingo', category: 'Learning', tags: ['german'] });
    await api(token).post('/api/memories').send({ content: 'Plays guitar', category: 'Learning' });
    await models.Memory.syncIndexes();

    const res = await api(token).get('/api/memories/search?q=german');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.results[0].score).toBeGreaterThanOrEqual(res.body.results[1].score);
  });

  test('requires a non-empty string q', async () => {
    const { token } = await setup();
    expect((await api(token).get('/api/memories/search')).status).toBe(400);
    expect((await api(token).get('/api/memories/search?q=%20')).status).toBe(400);
    expect((await api(token).get('/api/memories/search?q[$ne]=x')).status).toBe(400);
  });
});
