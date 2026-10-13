const mongoose = require('mongoose');
const { connect, disconnect, createUser, api, models } = require('./helpers');
const { migrate } = require('../scripts/migrate-stage2');

beforeAll(connect);
afterAll(disconnect);

// Rebuilds what a Stage 1 database looked like: memories with no temporal fields and the Stage 1 indexes
async function makeStage1Database() {
  const db = mongoose.connection.db;
  for (const collection of ['users', 'categories', 'memories', 'auditlog']) {
    await db.collection(collection).deleteMany({});
  }
  await db.collection('memories').dropIndexes();
  await db.collection('memories').createIndexes([
    { key: { userId: 1, _id: -1 }, name: 'userId_1__id_-1' },
    { key: { userId: 1, status: 1, _id: -1 }, name: 'userId_1_status_1__id_-1' },
    { key: { userId: 1, categoryId: 1, _id: -1 }, name: 'userId_1_categoryId_1__id_-1' },
    { key: { categoryId: 1 }, name: 'categoryId_1' },
  ]);

  const { user, token } = await createUser();
  const health = await db.collection('categories').insertOne({ name: 'Health' });
  const hobbies = await db.collection('categories').insertOne({ name: 'Hobbies' });
  const createdAt = new Date('2025-02-03T04:05:06Z');
  const noCreatedAt = new mongoose.Types.ObjectId(Math.floor(Date.parse('2024-05-06T07:08:09Z') / 1000));
  await db.collection('memories').insertMany([
    { userId: user._id, categoryId: health.insertedId, content: 'Allergic to peanuts', importance: 5, status: 'Active', tags: [], createdAt, updatedAt: createdAt },
    { userId: user._id, categoryId: hobbies.insertedId, content: 'Plays chess', importance: 3, status: 'Archived', tags: ['chess'], createdAt, updatedAt: createdAt },
    // A very old document without timestamps: its ObjectId still holds its creation time
    { _id: noCreatedAt, userId: user._id, categoryId: hobbies.insertedId, content: 'Paints', importance: 2, status: 'Active', tags: [] },
  ]);
  return { user, token, noCreatedAt };
}

describe('Stage 2 migration', () => {
  test('turns every Stage 1 memory into a current first version with a log entry', async () => {
    const { user, token } = await makeStage1Database();
    const result = await migrate();
    expect(result.convertedMemories).toBe(3);
    expect(result.droppedIndexes.sort()).toEqual(
      ['memories.categoryId_1', 'memories.userId_1__id_-1', 'memories.userId_1_categoryId_1__id_-1', 'memories.userId_1_status_1__id_-1'].sort()
    );

    const peanut = await models.Memory.findOne({ content: 'Allergic to peanuts' }).lean();
    expect(peanut.validFrom.toISOString()).toBe('2025-02-03T04:05:06.000Z');
    expect(peanut.recordedAt.toISOString()).toBe('2025-02-03T04:05:06.000Z');
    expect(peanut).toMatchObject({ validTo: null, retractedAt: null, closedAt: null, supersedes: null, supersededBy: null, confidence: 1, sensitivity: 'special', accessCount: 0, sourceMessageIds: [] });
    expect((await models.Memory.findOne({ content: 'Plays chess' }).lean()).sensitivity).toBe('normal');
    expect((await models.Memory.findOne({ content: 'Paints' }).lean()).validFrom.toISOString()).toBe('2024-05-06T07:08:09.000Z');

    const log = await models.AuditLog.find({ userId: user._id }).lean();
    expect(log).toHaveLength(3);
    expect(log.every((e) => e.action === 'migrate' && e.actorId === null)).toBe(true);

    const indexes = (await models.Memory.collection.indexes()).map((i) => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['userId_1_validTo_1_retractedAt_1__id_-1', 'userId_1__id_-1_validFrom_1_recordedAt_1', 'supersedes_1']));

    // The migrated memories behave like any other: listed as current, and they can be superseded
    const list = await api(token).get('/api/memories');
    expect(list.body.count).toBe(3);
    expect((await api(token).put(`/api/memories/${peanut._id}`).send({ content: 'Allergic to peanuts and cashews' })).status).toBe(200);
    expect((await api(token).get('/api/memories?asOf=2025-01-01')).body.memories.map((m) => m.content)).toEqual(['Paints']);
  });

  test('is safe to run twice: the second run changes nothing', async () => {
    await makeStage1Database();
    await migrate();
    const before = await models.Memory.find().sort({ _id: 1 }).lean();
    const second = await migrate();
    expect(second).toEqual({ droppedIndexes: [], convertedMemories: 0 });
    expect(await models.Memory.find().sort({ _id: 1 }).lean()).toEqual(before);
    expect(await models.AuditLog.countDocuments()).toBe(3);
  });

  test('never overwrites temporal values that are already there', async () => {
    await makeStage1Database();
    const db = mongoose.connection.db;
    // Half-migrated document: has validFrom and sensitivity but no recordedAt
    await db.collection('memories').updateOne({ content: 'Plays chess' }, { $set: { validFrom: new Date('2021-01-01'), sensitivity: 'personal' } });
    await migrate();
    const chess = await models.Memory.findOne({ content: 'Plays chess' }).lean();
    expect(chess.validFrom.toISOString()).toBe('2021-01-01T00:00:00.000Z');
    expect(chess.sensitivity).toBe('personal');
    expect(chess.recordedAt.toISOString()).toBe('2025-02-03T04:05:06.000Z');
  });
});
