const { connect, disconnect, createUser, createCategory, models } = require('./helpers');

beforeAll(connect);
afterAll(disconnect);

const keyOf = (index) => JSON.stringify(index.key);

async function indexesOf(Model) {
  return Model.collection.indexes();
}

describe('index design', () => {
  test('memories: the redundant standalone userId and status indexes are gone', async () => {
    const names = (await indexesOf(models.Memory)).map((i) => i.name);
    expect(names).not.toContain('userId_1');
    expect(names).not.toContain('status_1');
    expect(names).not.toContain('userId_1_status_1_importance_-1');
  });

  test('memories: exactly the documented indexes exist', async () => {
    const indexes = await indexesOf(models.Memory);
    expect(indexes.map(keyOf).sort()).toEqual(
      [
        { _id: 1 },
        { userId: 1, _id: -1 },
        { userId: 1, status: 1, _id: -1 },
        { userId: 1, categoryId: 1, _id: -1 },
        { categoryId: 1 },
        { userId: 1, _fts: 'text', _ftsx: 1 },
      ]
        .map((k) => JSON.stringify(k))
        .sort()
    );
  });

  test('no collection has two indexes with the same key pattern', async () => {
    for (const Model of Object.values(models)) {
      const keys = (await indexesOf(Model)).map(keyOf);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  test('messages are indexed by { conversationId, sentAt }', async () => {
    expect((await indexesOf(models.Message)).map(keyOf)).toContain(JSON.stringify({ conversationId: 1, sentAt: 1 }));
  });

  test('email and category name are unique', async () => {
    const users = await indexesOf(models.User);
    expect(users.find((i) => i.name === 'email_1').unique).toBe(true);
    const categories = await indexesOf(models.Category);
    const byName = categories.find((i) => i.name === 'name_unique_ci');
    expect(byName.unique).toBe(true);
    expect(byName.collation.strength).toBe(2);
  });
});

describe('queries use the indexes (explain)', () => {
  let user;
  let category;

  beforeAll(async () => {
    ({ user } = await createUser());
    category = await createCategory('Health');
    const other = (await createUser()).user;
    // Many documents of other users, so a scan of the whole collection would visibly cost more than the index
    const docs = [];
    for (let i = 0; i < 300; i++) {
      docs.push({ userId: i % 3 === 0 ? user._id : other._id, categoryId: category._id, content: `memory ${i}`, status: i % 2 ? 'Active' : 'Archived' });
    }
    await models.Memory.insertMany(docs);
  });

  const stagesOf = (plan, out = []) => {
    if (!plan) return out;
    out.push(plan.stage);
    stagesOf(plan.inputStage, out);
    (plan.inputStages || []).forEach((p) => stagesOf(p, out));
    return out;
  };

  // MongoDB 8 reports a single-field equality lookup with limit(1) as EXPRESS_IXSCAN (a faster path that still
  // uses the index), while MongoDB 7 reports IXSCAN. Both mean "an index was used".
  const usesIndex = (stages) => stages.some((stage) => /IXSCAN$/.test(stage));

  const explainFind = (query) => query.explain('executionStats');

  test('listing a user\'s memories uses an index, reads only their documents and needs no SORT', async () => {
    const e = await explainFind(models.Memory.find({ userId: user._id }).sort({ _id: -1 }).limit(21));
    const stages = stagesOf(e.queryPlanner.winningPlan);
    expect(usesIndex(stages)).toBe(true);
    expect(stages).not.toContain('COLLSCAN');
    expect(stages).not.toContain('SORT');
    expect(e.executionStats.totalDocsExamined).toBeLessThanOrEqual(21);
  });

  test('filtering by status uses an index with no SORT', async () => {
    const e = await explainFind(models.Memory.find({ userId: user._id, status: 'Active' }).sort({ _id: -1 }).limit(21));
    const stages = stagesOf(e.queryPlanner.winningPlan);
    expect(usesIndex(stages)).toBe(true);
    expect(stages).not.toContain('COLLSCAN');
    expect(stages).not.toContain('SORT');
  });

  test('filtering by category uses an index with no SORT', async () => {
    const e = await explainFind(models.Memory.find({ userId: user._id, categoryId: category._id }).sort({ _id: -1 }).limit(21));
    const stages = stagesOf(e.queryPlanner.winningPlan);
    expect(usesIndex(stages)).toBe(true);
    expect(stages).not.toContain('COLLSCAN');
    expect(stages).not.toContain('SORT');
  });

  test('the "is this category in use" check uses the categoryId index', async () => {
    const e = await explainFind(models.Memory.find({ categoryId: category._id }).limit(1));
    expect(usesIndex(stagesOf(e.queryPlanner.winningPlan))).toBe(true);
    expect(stagesOf(e.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
  });

  test('conversations and messages lookups use their indexes', async () => {
    const conversation = await models.Conversation.create({ userId: user._id, title: 'x' });
    await models.Message.create({ conversationId: conversation._id, role: 'user', content: 'x' });
    const c = await explainFind(models.Conversation.find({ userId: user._id }).sort({ _id: -1 }).limit(21));
    expect(usesIndex(stagesOf(c.queryPlanner.winningPlan))).toBe(true);
    const m = await explainFind(models.Message.find({ conversationId: conversation._id }).sort({ sentAt: 1 }).limit(21));
    expect(usesIndex(stagesOf(m.queryPlanner.winningPlan))).toBe(true);
    expect(stagesOf(m.queryPlanner.winningPlan)).not.toContain('SORT');
  });
});
