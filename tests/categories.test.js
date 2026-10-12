const { connect, disconnect, clear, api, createUser, createAdmin, createCategory, models } = require('./helpers');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

describe('categories', () => {
  test('any signed-in user can list and read categories', async () => {
    const { token } = await createUser();
    const category = await createCategory('Health');
    const list = await api(token).get('/api/categories');
    expect(list.status).toBe(200);
    expect(list.body.categories.map((c) => c.name)).toEqual(['Health']);
    expect((await api(token).get(`/api/categories/${category._id}`)).body.name).toBe('Health');
  });

  test('a normal user cannot create, update or delete (403)', async () => {
    const { token } = await createUser();
    const category = await createCategory('Health');
    expect((await api(token).post('/api/categories').send({ name: 'Travel' })).status).toBe(403);
    expect((await api(token).put(`/api/categories/${category._id}`).send({ name: 'X' })).status).toBe(403);
    expect((await api(token).delete(`/api/categories/${category._id}`)).status).toBe(403);
    expect(await models.Category.countDocuments()).toBe(1);
  });

  test('an admin can create, update and delete', async () => {
    const { token } = await createAdmin();
    const created = await api(token).post('/api/categories').send({ name: 'Travel', description: 'Trips' });
    expect(created.status).toBe(201);
    const updated = await api(token).put(`/api/categories/${created.body._id}`).send({ description: 'Trips and plans' });
    expect(updated.body.description).toBe('Trips and plans');
    expect((await api(token).delete(`/api/categories/${created.body._id}`)).status).toBe(200);
    expect((await api(token).get(`/api/categories/${created.body._id}`)).status).toBe(404);
  });

  test('names are unique ignoring case (409), on create and on rename', async () => {
    const { token } = await createAdmin();
    await api(token).post('/api/categories').send({ name: 'Health' });
    expect((await api(token).post('/api/categories').send({ name: 'health' })).status).toBe(409);
    const other = await api(token).post('/api/categories').send({ name: 'Travel' });
    expect((await api(token).put(`/api/categories/${other.body._id}`).send({ name: 'HEALTH' })).status).toBe(409);
  });

  test('validation: name is required, object names and bad ids are rejected', async () => {
    const { token } = await createAdmin();
    expect((await api(token).post('/api/categories').send({})).status).toBe(400);
    expect((await api(token).post('/api/categories').send({ name: { $gt: '' } })).status).toBe(400);
    expect((await api(token).put('/api/categories/not-an-id').send({ name: 'X' })).status).toBe(400);
    const c = await createCategory('Health');
    expect((await api(token).put(`/api/categories/${c._id}`).send({})).status).toBe(400);
    expect((await api(token).get('/api/categories/507f1f77bcf86cd799439011')).status).toBe(404);
  });

  test('deleting a category that still has memories is blocked with 409; allowed once they are gone', async () => {
    const admin = await createAdmin();
    const category = await createCategory('Health');
    const memory = (await api(admin.token).post('/api/memories').send({ content: 'x', category: 'Health' })).body;

    const blocked = await api(admin.token).delete(`/api/categories/${category._id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/1 memories/);
    expect(await models.Category.countDocuments({ _id: category._id })).toBe(1);

    await api(admin.token).delete(`/api/memories/${memory._id}`);
    expect((await api(admin.token).delete(`/api/categories/${category._id}`)).status).toBe(200);
  });

  test('the category is found by name regardless of case when creating a memory', async () => {
    const { token } = await createUser();
    await createCategory('Learning');
    const res = await api(token).post('/api/memories').send({ content: 'x', category: 'lEaRnInG' });
    expect(res.status).toBe(201);
    expect(res.body.categoryId.name).toBe('Learning');
  });

  test('pagination: limit and cursor walk through all categories once', async () => {
    const { token } = await createUser();
    for (const name of ['A', 'B', 'C', 'D', 'E']) await createCategory(name);
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const res = await api(token).get(`/api/categories?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.count).toBeLessThanOrEqual(2);
      seen.push(...res.body.categories.map((c) => c.name));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(pages).toBe(3);
  });
});
