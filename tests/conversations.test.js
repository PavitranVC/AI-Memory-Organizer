const { connect, disconnect, clear, api, createUser, createCategory, models } = require('./helpers');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

async function newConversation(token, title = 'Chat') {
  return (await api(token).post('/api/conversations').send({ title })).body;
}

describe('conversations CRUD', () => {
  test('create, read (with message count), update, list, delete', async () => {
    const { token } = await createUser();
    const created = await api(token).post('/api/conversations').send({ title: '  Trip planning ' });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe('Trip planning');

    const id = created.body._id;
    await api(token).post(`/api/conversations/${id}/messages`).send({ role: 'user', content: 'hi' });
    const read = await api(token).get(`/api/conversations/${id}`);
    expect(read.body).toMatchObject({ title: 'Trip planning', messageCount: 1 });
    expect(read.body.messages).toBeUndefined(); // messages are a separate collection

    const updated = await api(token).put(`/api/conversations/${id}`).send({ title: 'Renamed' });
    expect(updated.body.title).toBe('Renamed');

    expect((await api(token).get('/api/conversations')).body.conversations).toHaveLength(1);

    const deleted = await api(token).delete(`/api/conversations/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.deletedMessages).toBe(1);
    expect((await api(token).get(`/api/conversations/${id}`)).status).toBe(404);
  });

  test('validation', async () => {
    const { token } = await createUser();
    expect((await api(token).post('/api/conversations').send({})).status).toBe(400);
    expect((await api(token).post('/api/conversations').send({ title: 'x'.repeat(201) })).status).toBe(400);
    expect((await api(token).post('/api/conversations').send({ title: { $gt: '' } })).status).toBe(400);
    const c = await newConversation(token);
    expect((await api(token).put(`/api/conversations/${c._id}`).send({})).status).toBe(400);
    expect((await api(token).get('/api/conversations/not-an-id')).status).toBe(400);
  });

  test('a body userId is ignored: the conversation belongs to the caller', async () => {
    const a = await createUser();
    const b = await createUser();
    const res = await api(a.token).post('/api/conversations').send({ title: 'Mine', userId: String(b.user._id) });
    expect(res.body.userId).toBe(String(a.user._id));
  });

  test("user A cannot see, change, delete or write into user B's conversation", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversation = await newConversation(b.token, 'Private');
    await api(b.token).post(`/api/conversations/${conversation._id}/messages`).send({ role: 'user', content: 'secret' });

    const id = conversation._id;
    expect((await api(a.token).get(`/api/conversations/${id}`)).status).toBe(404);
    expect((await api(a.token).put(`/api/conversations/${id}`).send({ title: 'Hacked' })).status).toBe(404);
    expect((await api(a.token).delete(`/api/conversations/${id}`)).status).toBe(404);
    expect((await api(a.token).get(`/api/conversations/${id}/messages`)).status).toBe(404);
    expect((await api(a.token).post(`/api/conversations/${id}/messages`).send({ role: 'user', content: 'x' })).status).toBe(404);
    expect((await api(a.token).get('/api/conversations')).body.conversations).toHaveLength(0);

    expect((await models.Conversation.findById(id)).title).toBe('Private');
    expect(await models.Message.countDocuments({ conversationId: id })).toBe(1);
  });

  test('deleting a conversation keeps its memories but unlinks them', async () => {
    const { token } = await createUser();
    await createCategory('Health');
    const conversation = await newConversation(token);
    const memory = (await api(token).post('/api/memories').send({ content: 'x', category: 'Health', conversationId: conversation._id })).body;

    const res = await api(token).delete(`/api/conversations/${conversation._id}`);
    expect(res.body.unlinkedMemories).toBe(1);
    const kept = await models.Memory.findById(memory._id).lean();
    expect(kept).toBeTruthy();
    expect(kept.conversationId).toBeUndefined();
  });

  test('pagination of conversations is newest first and complete', async () => {
    const { token } = await createUser();
    for (let i = 1; i <= 5; i++) await newConversation(token, `C${i}`);
    const first = await api(token).get('/api/conversations?limit=2');
    expect(first.body.conversations.map((c) => c.title)).toEqual(['C5', 'C4']);
    const second = await api(token).get(`/api/conversations?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.conversations.map((c) => c.title)).toEqual(['C3', 'C2']);
    const third = await api(token).get(`/api/conversations?limit=2&cursor=${second.body.nextCursor}`);
    expect(third.body.conversations.map((c) => c.title)).toEqual(['C1']);
    expect(third.body.nextCursor).toBeNull();
  });
});

describe('messages', () => {
  test('are returned in chat order and paginate without gaps or repeats', async () => {
    const { token } = await createUser();
    const c = await newConversation(token);
    for (let i = 1; i <= 7; i++) {
      await api(token).post(`/api/conversations/${c._id}/messages`).send({ role: i % 2 ? 'user' : 'assistant', content: `m${i}` });
    }
    const seen = [];
    let cursor;
    do {
      const res = await api(token).get(`/api/conversations/${c._id}/messages?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.messages.map((m) => m.content));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
  });

  test('messages with identical timestamps still paginate in a stable order', async () => {
    const { token } = await createUser();
    const c = await newConversation(token);
    const sentAt = new Date();
    await models.Message.insertMany(['a', 'b', 'c', 'd', 'e'].map((content) => ({ conversationId: c._id, role: 'user', content, sentAt })));
    const seen = [];
    let cursor;
    do {
      const res = await api(token).get(`/api/conversations/${c._id}/messages?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...res.body.messages.map((m) => m.content));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('validation: role, content, and a cursor from another conversation', async () => {
    const { token } = await createUser();
    const c1 = await newConversation(token);
    const c2 = await newConversation(token);
    const m = (await api(token).post(`/api/conversations/${c1._id}/messages`).send({ role: 'user', content: 'x' })).body;
    expect((await api(token).post(`/api/conversations/${c1._id}/messages`).send({ role: 'robot', content: 'x' })).status).toBe(400);
    expect((await api(token).post(`/api/conversations/${c1._id}/messages`).send({ role: 'user' })).status).toBe(400);
    expect((await api(token).get(`/api/conversations/${c2._id}/messages?cursor=${m._id}`)).status).toBe(400);
  });
});
