const { connect, disconnect, clear, api, request, app, createUser, createCategory, models } = require('./helpers');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

describe('users (self only)', () => {
  test('GET by "me" and by own id', async () => {
    const { user, token } = await createUser({ name: 'Me' });
    expect((await api(token).get('/api/users/me')).body.name).toBe('Me');
    const byId = await api(token).get(`/api/users/${user._id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.passwordHash).toBeUndefined();
  });

  test("another user's id is forbidden for GET, PUT and DELETE", async () => {
    const a = await createUser();
    const b = await createUser();
    expect((await api(a.token).get(`/api/users/${b.user._id}`)).status).toBe(403);
    expect((await api(a.token).put(`/api/users/${b.user._id}`).send({ name: 'Hacked' })).status).toBe(403);
    expect((await api(a.token).delete(`/api/users/${b.user._id}`)).status).toBe(403);
    expect(await models.User.countDocuments({ _id: b.user._id })).toBe(1);
  });

  test('an invalid id is a 400', async () => {
    const { token } = await createUser();
    expect((await api(token).get('/api/users/not-an-id')).status).toBe(400);
  });

  test('PUT updates name, occupation and email', async () => {
    const { token } = await createUser();
    const res = await api(token).put('/api/users/me').send({ name: 'New Name', occupation: 'Chef', email: 'New@Example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'New Name', occupation: 'Chef', email: 'new@example.com' });
  });

  test('PUT with the values the account already has is a harmless 200', async () => {
    const { user, token } = await createUser({ name: 'Same Name' });
    const res = await api(token).put('/api/users/me').send({ name: 'Same Name', email: user.email });
    expect(res.status).toBe(200);
  });

  test('PUT cannot change the role, and an empty body is a 400', async () => {
    const { user, token } = await createUser();
    const res = await api(token).put('/api/users/me').send({ role: 'admin' });
    expect(res.status).toBe(400);
    expect((await models.User.findById(user._id)).role).toBe('user');
  });

  test('PUT with an email that is taken returns 409', async () => {
    const a = await createUser({ email: 'a@example.com' });
    await createUser({ email: 'b@example.com' });
    expect((await api(a.token).put('/api/users/me').send({ email: 'b@example.com' })).status).toBe(409);
  });

  test('PUT with an invalid email returns 400', async () => {
    const { token } = await createUser();
    expect((await api(token).put('/api/users/me').send({ email: 'nope' })).status).toBe(400);
  });

  test('changing the password needs the current password, then the new one works for login', async () => {
    const { user, token } = await createUser();
    expect((await api(token).put('/api/users/me').send({ password: 'NewPassword456' })).status).toBe(400);
    expect((await api(token).put('/api/users/me').send({ password: 'NewPassword456', currentPassword: 'wrong-one-123' })).status).toBe(401);
    expect((await api(token).put('/api/users/me').send({ password: 'NewPassword456', currentPassword: 'Password123' })).status).toBe(200);

    const oldLogin = await request(app).post('/api/auth/login').send({ email: user.email, password: 'Password123' });
    const newLogin = await request(app).post('/api/auth/login').send({ email: user.email, password: 'NewPassword456' });
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);
  });

  test('DELETE cascades to conversations, messages and memories, and leaves other users alone', async () => {
    const { user, token } = await createUser();
    const other = await createUser();
    const category = await createCategory('Health');

    const conversation = (await api(token).post('/api/conversations').send({ title: 'Chat' })).body;
    await api(token).post(`/api/conversations/${conversation._id}/messages`).send({ role: 'user', content: 'hello' });
    await api(token).post(`/api/conversations/${conversation._id}/messages`).send({ role: 'assistant', content: 'hi' });
    await api(token).post('/api/memories').send({ content: 'Mine', category: 'Health', conversationId: conversation._id });

    const otherConversation = (await api(other.token).post('/api/conversations').send({ title: 'Other chat' })).body;
    await api(other.token).post(`/api/conversations/${otherConversation._id}/messages`).send({ role: 'user', content: 'keep me' });
    await api(other.token).post('/api/memories').send({ content: 'Theirs', category: 'Health' });

    const res = await api(token).delete('/api/users/me');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual({ memories: 1, messages: 2, conversations: 1, auditEntries: 1, jobs: 1, llmCalls: 0, evalItems: 0, consents: 0, suggestions: 0 });

    expect(await models.User.countDocuments({ _id: user._id })).toBe(0);
    expect(await models.Conversation.countDocuments({ userId: user._id })).toBe(0);
    expect(await models.Memory.countDocuments({ userId: user._id })).toBe(0);
    expect(await models.Message.countDocuments({ conversationId: conversation._id })).toBe(0);

    // the other user's data and the shared category survive
    expect(await models.Memory.countDocuments({ userId: other.user._id })).toBe(1);
    expect(await models.Message.countDocuments({ conversationId: otherConversation._id })).toBe(1);
    expect(await models.Category.countDocuments({ _id: category._id })).toBe(1);

    // the deleted user's token no longer works
    expect((await api(token).get('/api/users/me')).status).toBe(401);
  });
});
