// Stage 7: retention policy for special-sensitivity memories (a scheduled job, not a TTL index)
const path = require('path');
const { execFile } = require('child_process');
const { connect, disconnect, clear, api, createUser, createCategory, models } = require('./helpers');
const { retentionDays, purgeExpired, expiredFilter } = require('../services/retentionService');
const { verifyErasure } = require('../services/erasureVerifier');

const { Memory, AuditLog } = models;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  await Promise.all(['Personal', 'Health'].map((name) => createCategory(name)));
});

// Creates a memory through the API, then moves its transaction time into the past (as if stored long ago)
async function stored(token, body, daysAgo) {
  const memory = (await api(token).post('/api/memories').send(body)).body;
  await Memory.collection.updateOne({ _id: new Memory.base.Types.ObjectId(memory._id) }, { $set: { recordedAt: new Date(Date.now() - daysAgo * DAY) } });
  return memory;
}

describe('retention of special-sensitivity memories', () => {
  test('RETENTION_SPECIAL_DAYS: unset or 0 is off, a positive number is the period, anything else is an error', () => {
    expect(retentionDays(undefined)).toBe(0);
    expect(retentionDays('')).toBe(0);
    expect(retentionDays('0')).toBe(0);
    expect(retentionDays('365')).toBe(365);
    expect(() => retentionDays('-1')).toThrow(/number of days/);
    expect(() => retentionDays('soon')).toThrow(/number of days/);
  });

  test('off by default: nothing is erased', async () => {
    const { user, token } = await createUser();
    await stored(token, { content: 'Has asthma', category: 'Health' }, 1000);
    expect(await purgeExpired({ days: 0 })).toMatchObject({ enabled: false, erasedVersions: 0 });
    expect(await Memory.countDocuments({ userId: user._id })).toBe(1);
  });

  test('erases only special versions older than the period; normal, recent and dataset rows stay', async () => {
    const { user, token } = await createUser();
    const old = await stored(token, { content: 'Has asthma', category: 'Health' }, 400); // special by category
    await stored(token, { content: 'Had a fracture', category: 'Personal', sensitivity: 'special' }, 400);
    const recent = await stored(token, { content: 'Has a cold', category: 'Health' }, 10);
    const normal = await stored(token, { content: 'Lives in Pune', category: 'Personal' }, 400);
    const dataset = await stored(token, { content: 'Benchmark health fact', category: 'Health' }, 400);
    await Memory.collection.updateOne({ _id: new Memory.base.Types.ObjectId(dataset._id) }, { $set: { dataset: 'synthetic' } });

    const dry = await purgeExpired({ days: 365, dryRun: true });
    expect(dry).toMatchObject({ enabled: true, dryRun: true, users: 1, expiredVersions: 2, erasedVersions: 0 });
    expect(await Memory.countDocuments({ userId: user._id })).toBe(5);

    const result = await purgeExpired({ days: 365 });
    expect(result).toMatchObject({ expiredVersions: 2, erasedVersions: 2 });
    const left = (await Memory.find({ userId: user._id }).lean()).map((m) => String(m._id)).sort();
    expect(left).toEqual([recent._id, normal._id, dataset._id].sort());

    // Expiry is a logged erasure like any other: an "erase" entry by the retention job, no content kept
    const entry = await AuditLog.findOne({ memoryId: old._id, action: 'erase' }).lean();
    expect(entry).toMatchObject({ via: 'retention', actorId: null, before: null, after: null });
    expect(entry.reason).toMatch(/older than 365 days/);
    expect((await verifyErasure({ userId: user._id, text: 'asthma' })).ok).toBe(true);
    expect(await purgeExpired({ days: 365 })).toMatchObject({ expiredVersions: 0 }); // re-running is a no-op
  });

  test('an expired special version that superseded a normal one restores the normal one', async () => {
    const { user, token } = await createUser();
    const v1 = (await api(token).post('/api/memories').send({ content: 'Feels fine', category: 'Personal', validFrom: '2020-01-01' })).body;
    const v2 = (await api(token).put(`/api/memories/${v1._id}`).send({ content: 'Has diabetes', category: 'Health' })).body;
    expect(v2.sensitivity).toBe('special');
    const result = await purgeExpired({ days: 30, now: new Date(Date.now() + 31 * DAY) });
    expect(result).toMatchObject({ erasedVersions: 1, restoredVersions: 1 });
    const [now] = await Memory.find({ userId: user._id, validTo: null, retractedAt: null }).lean();
    expect(now.content).toBe('Feels fine');
  });

  test('the expiry query is served by the partial retention index', async () => {
    const explain = await Memory.find(expiredFilter(new Date())).explain('queryPlanner');
    expect(JSON.stringify(explain.queryPlanner.winningPlan)).toMatch(/retention_special/);
  });

  test('"npm run retention" says it is off when no period is configured', async () => {
    const env = { ...process.env, MONGO_URI: process.env.MONGO_URI_TEST };
    delete env.RETENTION_SPECIAL_DAYS;
    const stdout = await new Promise((resolve, reject) => {
      execFile('node', [path.join(__dirname, '..', 'scripts', 'retention.js')], { env }, (err, out) => (err ? reject(err) : resolve(out)));
    });
    expect(stdout).toMatch(/Retention is off/);
  });
});
