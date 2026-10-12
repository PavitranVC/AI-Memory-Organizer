const mongoose = require('mongoose');
const request = require('supertest');
const { connect, disconnect, app, models } = require('./helpers');
const { migrate } = require('../scripts/migrate-stage1');

beforeAll(connect);
afterAll(disconnect);

// Rebuilds what a pre-Stage-1 database looked like: old indexes, messages embedded in conversations, no passwords
async function makeLegacyDatabase() {
  const db = mongoose.connection.db;
  for (const collection of ['users', 'categories', 'conversations', 'messages', 'memories']) {
    await db.collection(collection).deleteMany({});
    await db.collection(collection).dropIndexes();
  }
  await db.collection('memories').createIndexes([
    { key: { userId: 1 }, name: 'userId_1' },
    { key: { categoryId: 1 }, name: 'categoryId_1' },
    { key: { status: 1 }, name: 'status_1' },
    { key: { userId: 1, status: 1, importance: -1 }, name: 'userId_1_status_1_importance_-1' },
    { key: { content: 'text', tags: 'text' }, name: 'content_text_tags_text' },
  ]);
  await db.collection('conversations').createIndex({ userId: 1, createdAt: -1 });
  await db.collection('categories').createIndex({ name: 1 }, { unique: true });

  const user = await db.collection('users').insertOne({ name: 'Old User', email: 'old@example.com' });
  const created = new Date('2025-01-01T10:00:00Z');
  const conversation = await db.collection('conversations').insertOne({
    userId: user.insertedId,
    title: 'Old chat',
    createdAt: created,
    messages: [
      { role: 'user', content: 'first', sentAt: new Date('2025-01-01T10:00:01Z') },
      { role: 'assistant', content: 'second', sentAt: new Date('2025-01-01T10:00:02Z') },
    ],
  });
  await db.collection('conversations').insertOne({ userId: user.insertedId, title: 'Empty chat', createdAt: created, messages: [] });
  return { userId: user.insertedId, conversationId: conversation.insertedId };
}

describe('Stage 1 migration', () => {
  test('drops the old indexes, builds the new ones, and moves embedded messages', async () => {
    const { conversationId } = await makeLegacyDatabase();

    const result = await migrate();

    expect(result.droppedIndexes.sort()).toEqual(
      [
        'categories.name_1',
        'conversations.userId_1_createdAt_-1',
        'memories.content_text_tags_text',
        'memories.status_1',
        'memories.userId_1',
        'memories.userId_1_status_1_importance_-1',
      ].sort()
    );
    expect(result.movedMessages).toBe(2);

    const memoryIndexes = (await models.Memory.collection.indexes()).map((i) => i.name);
    expect(memoryIndexes).not.toContain('userId_1');
    expect(memoryIndexes).not.toContain('status_1');
    expect(memoryIndexes).toEqual(expect.arrayContaining(['userId_1__id_-1', 'userId_1_status_1__id_-1', 'userId_1_categoryId_1__id_-1', 'categoryId_1', 'userId_1_content_text_tags_text']));

    const messages = await models.Message.find({ conversationId }).sort({ sentAt: 1 }).lean();
    expect(messages.map((m) => m.content)).toEqual(['first', 'second']);
    expect(await mongoose.connection.db.collection('conversations').countDocuments({ messages: { $exists: true } })).toBe(0);
    expect(result.usersWithoutPassword).toEqual(['old@example.com']);
  });

  test('is safe to run twice', async () => {
    await makeLegacyDatabase();
    await migrate();
    const second = await migrate();
    expect(second.droppedIndexes).toEqual([]);
    expect(second.movedMessages).toBe(0);
    expect(await models.Message.countDocuments()).toBe(2);
  });

  test('can give users without a password a default one so they can log in', async () => {
    await makeLegacyDatabase();
    const result = await migrate({ defaultPassword: 'MigratedPass123' });
    expect(result.passwordsSet).toBe(1);
    const login = await request(app).post('/api/auth/login').send({ email: 'old@example.com', password: 'MigratedPass123' });
    expect(login.status).toBe(200);
    const token = login.body.token;
    const conversations = await request(app).get('/api/conversations').set('Authorization', `Bearer ${token}`);
    expect(conversations.body.conversations).toHaveLength(2);
  });
});
