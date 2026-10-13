const crypto = require('crypto');
const { connect, disconnect, clear, createUser, createCategory, api, models } = require('./helpers');
const { generateSynthetic, removeSynthetic } = require('../services/datasets/synthetic');

const { User, Memory } = models;

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

// A fingerprint of every generated memory (ids and content), to compare two runs
async function fingerprint() {
  const docs = await Memory.find({ dataset: 'synthetic' }).sort({ _id: 1 }).select('content validFrom supersedes retractedAt').lean();
  return crypto.createHash('sha256').update(JSON.stringify(docs)).digest('hex');
}

describe('synthetic scale generator', () => {
  test('creates exactly the requested number of memories, all labelled synthetic', async () => {
    const summary = await generateSynthetic({ memories: 1201, users: 4, seed: 1, batchSize: 500 });
    expect(summary).toMatchObject({ users: 4, memories: 1201, versions: 1201 });
    expect(summary.current + summary.superseded + summary.retracted).toBe(1201);
    expect(summary.superseded).toBeGreaterThan(0);
    expect(summary.retracted).toBeGreaterThan(0);

    expect(await Memory.countDocuments()).toBe(1201);
    expect(await Memory.countDocuments({ dataset: { $ne: 'synthetic' } })).toBe(0);
    expect(await User.countDocuments({ dataset: 'synthetic', 'source.name': 'synthetic-scale' })).toBe(4);
    // Shared out evenly: 301 + 300 + 300 + 300
    const perUser = await Memory.aggregate([{ $group: { _id: '$userId', n: { $sum: 1 } } }]);
    expect(perUser.map((r) => r.n).sort()).toEqual([300, 300, 300, 301]);
  });

  test('generated documents pass the Memory schema and form valid version chains', async () => {
    await generateSynthetic({ memories: 800, users: 2, seed: 2 });
    const docs = await Memory.find().lean();
    for (const doc of docs.slice(0, 300)) expect(new Memory(doc).validateSync()).toBeUndefined();

    const byId = new Map(docs.map((d) => [String(d._id), d]));
    for (const doc of docs) {
      if (doc.supersededBy) {
        const next = byId.get(String(doc.supersededBy));
        expect(String(next.supersedes)).toBe(String(doc._id)); // the links agree in both directions
        expect(doc.validTo.getTime()).toBe(next.validFrom.getTime()); // valid time hands over without a gap
        expect(next.recordedAt.getTime()).toBeGreaterThan(doc.validFrom.getTime());
        expect(String(next.userId)).toBe(String(doc.userId));
      } else {
        expect(doc.validTo).toBeNull(); // only superseded versions are closed
      }
    }
    // The current state the API shows equals the generator's own count of current versions
    const current = await Memory.countDocuments({ validTo: null, retractedAt: null });
    expect(current).toBe(docs.filter((d) => !d.supersededBy && !d.retractedAt).length);
  });

  test('the same seed gives the same data; another seed gives different data', async () => {
    await generateSynthetic({ memories: 500, users: 2, seed: 7 });
    const first = await fingerprint();
    await generateSynthetic({ memories: 500, users: 2, seed: 7, reset: true });
    expect(await fingerprint()).toBe(first);
    await generateSynthetic({ memories: 500, users: 2, seed: 8, reset: true });
    expect(await fingerprint()).not.toBe(first);
  });

  test('refuses to mix runs without reset, and removal leaves non-synthetic data alone', async () => {
    const { user, token } = await createUser();
    await createCategory('Learning');
    await api(token).post('/api/memories').send({ content: 'My own memory', category: 'Learning' });
    await generateSynthetic({ memories: 300, users: 1, seed: 3 });
    await expect(generateSynthetic({ memories: 300, users: 1, seed: 3 })).rejects.toThrow(/--reset/);

    expect(await removeSynthetic()).toMatchObject({ users: 1, memories: 300 });
    expect(await Memory.countDocuments()).toBe(1);
    expect(await User.exists({ _id: user._id })).not.toBeNull();
  });

  test('rejects impossible sizes', async () => {
    await expect(generateSynthetic({ memories: 0 })).rejects.toThrow(/positive/);
    await expect(generateSynthetic({ memories: 5, users: 6 })).rejects.toThrow(/users/);
  });

  test('a synthetic user\'s memories are served by the normal API queries', async () => {
    const summary = await generateSynthetic({ memories: 250, users: 1, seed: 4 });
    const user = await User.findOne({ dataset: 'synthetic' });
    const { signToken } = require('../services/authService');
    const res = await api(signToken(user)).get('/api/memories?limit=100');
    expect(res.status).toBe(200);
    expect(res.body.memories.length).toBe(Math.min(100, summary.current));
    expect(res.body.memories.every((m) => m.dataset === 'synthetic' && m.validTo === null)).toBe(true);
  });
});
