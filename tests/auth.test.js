const { connect, disconnect, clear, api, request, app, createUser, models } = require('./helpers');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

const newAccount = { name: 'Asha Rao', email: 'Asha@Example.com', password: 'Password123', occupation: 'Engineer' };

describe('POST /api/auth/register', () => {
  test('creates a user, returns a token, and never returns the password hash', async () => {
    const res = await request(app).post('/api/auth/register').send(newAccount);
    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user.email).toBe('asha@example.com'); // lowercased
    expect(res.body.user.role).toBe('user');
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.user.password).toBeUndefined();
  });

  test('stores a bcrypt hash, not the password', async () => {
    await request(app).post('/api/auth/register').send(newAccount);
    const stored = await models.User.findOne({ email: 'asha@example.com' }).select('+passwordHash');
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored.passwordHash).not.toContain('Password123');
  });

  test('cannot make yourself an admin', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...newAccount, role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('user');
  });

  test('rejects a duplicate email with 409', async () => {
    await request(app).post('/api/auth/register').send(newAccount);
    const res = await request(app).post('/api/auth/register').send({ ...newAccount, email: 'asha@example.com' });
    expect(res.status).toBe(409);
  });

  test.each([
    ['short password', { password: 'short' }],
    ['password over 72 bytes', { password: 'x'.repeat(73) }],
    ['missing password', { password: undefined }],
    ['missing email', { email: undefined }],
    ['invalid email', { email: 'not-an-email' }],
    ['missing name', { name: undefined }],
  ])('rejects %s with 400', async (label, change) => {
    const res = await request(app).post('/api/auth/register').send({ ...newAccount, ...change });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
  });

  test('rejects a malformed JSON body with 400', async () => {
    const res = await request(app).post('/api/auth/register').set('Content-Type', 'application/json').send('{ nope');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/auth/register').send(newAccount);
  });

  test('returns a token that works on a protected route', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'asha@example.com', password: 'Password123' });
    expect(login.status).toBe(200);
    const me = await api(login.body.token).get('/api/users/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('asha@example.com');
  });

  test('email is case-insensitive', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'ASHA@EXAMPLE.COM', password: 'Password123' });
    expect(res.status).toBe(200);
  });

  test('wrong password and unknown email give the same 401', async () => {
    const wrong = await request(app).post('/api/auth/login').send({ email: 'asha@example.com', password: 'WrongPassword1' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'Password123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toBe(unknown.body.error);
  });

  test('a query-operator object instead of a string is rejected (NoSQL injection)', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: { $gt: '' }, password: { $gt: '' } });
    expect(res.status).toBe(400);
  });

  test('a user without a password hash cannot log in', async () => {
    await models.User.collection.insertOne({ name: 'Legacy', email: 'legacy@example.com' });
    const res = await request(app).post('/api/auth/login').send({ email: 'legacy@example.com', password: 'Password123' });
    expect(res.status).toBe(401);
  });
});

describe('authentication on protected routes', () => {
  test.each(['/api/memories', '/api/conversations', '/api/categories', '/api/users/me', '/api/memories/stats/by-category'])(
    'GET %s without a token returns 401',
    async (url) => {
      expect((await api().get(url)).status).toBe(401);
    }
  );

  test('a malformed or wrongly signed token returns 401', async () => {
    expect((await api('garbage').get('/api/memories')).status).toBe(401);
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ sub: '507f1f77bcf86cd799439011' }, 'another-secret');
    expect((await api(forged).get('/api/memories')).status).toBe(401);
  });

  test('a token signed with the "none" algorithm is rejected', async () => {
    const { user } = await createUser();
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: String(user._id) })}.`;
    expect((await api(unsigned).get('/api/memories')).status).toBe(401);
  });

  test('an expired token returns 401', async () => {
    const jwt = require('jsonwebtoken');
    const { user } = await createUser();
    const expired = jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET, { expiresIn: -10 });
    const res = await api(expired).get('/api/memories');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  test('the token of a deleted user stops working', async () => {
    const { user, token } = await createUser();
    await models.User.deleteOne({ _id: user._id });
    expect((await api(token).get('/api/memories')).status).toBe(401);
  });
});
