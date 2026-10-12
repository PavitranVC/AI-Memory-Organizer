// Stage 3 pipeline against a real MongoDB, with the deterministic mock LLM only.
const { connect, disconnect, clear, api, createUser, createCategory, models } = require('./helpers');
const worker = require('../services/worker');
const jobService = require('../services/jobService');
const extraction = require('../services/extractionService');
const consent = require('../services/consentService');
const llm = require('../services/llm');
const { MockProvider } = require('../services/llm/mockProvider');

const { Job, LlmCall, Memory, AuditLog, Message } = models;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  await Promise.all(['Personal', 'Health', 'Learning', 'Hobbies'].map((name) => createCategory(name)));
});
afterEach(() => {
  llm.setProvider(null);
  jest.restoreAllMocks();
});

async function chat(token, title = 'Chat') {
  const conversation = (await api(token).post('/api/conversations').send({ title })).body;
  const say = async (content, role = 'user') => {
    const res = await api(token).post(`/api/conversations/${conversation._id}/messages`).send({ role, content });
    expect(res.status).toBe(201);
    return res.body;
  };
  return { conversation, say };
}

const current = (userId) => Memory.find({ userId, validTo: null, retractedAt: null }).sort({ _id: 1 }).lean();

describe('posting a message queues extraction instead of running it', () => {
  test('a user message returns 201 at once with a pending job; nothing is extracted until the worker runs', async () => {
    const { user, token } = await createUser();
    const { say } = await chat(token);
    const message = await say('I live in Pune');
    expect(message.extractionJobId).toBeTruthy();

    const job = await Job.findById(message.extractionJobId).lean();
    expect(job).toMatchObject({ type: 'extract', status: 'pending', attempts: 0 });
    expect(String(job.payload.messageId)).toBe(message._id);
    expect(await Memory.countDocuments({ userId: user._id })).toBe(0);
    expect(await LlmCall.countDocuments()).toBe(0);

    expect(await worker.drain()).toBe(1);
    expect((await Job.findById(job._id).lean()).status).toBe('done');
    expect(await Memory.countDocuments({ userId: user._id })).toBe(1);
  });

  test('assistant messages are not mined, and EXTRACTION_ENABLED=false turns queuing off', async () => {
    const { token } = await createUser();
    const { say } = await chat(token);
    expect((await say('You said you live in Pune?', 'assistant')).extractionJobId).toBeNull();
    process.env.EXTRACTION_ENABLED = 'false';
    try {
      expect((await say('I live in Pune')).extractionJobId).toBeNull();
    } finally {
      delete process.env.EXTRACTION_ENABLED;
    }
    expect(await Job.countDocuments()).toBe(0);
  });

  test('an invalid message saves neither the message nor a job (one transaction)', async () => {
    const { token } = await createUser();
    const { conversation } = await chat(token);
    const res = await api(token).post(`/api/conversations/${conversation._id}/messages`).send({ role: 'robot', content: 'I live in Pune' });
    expect(res.status).toBe(400);
    expect(await Message.countDocuments()).toBe(0);
    expect(await Job.countDocuments()).toBe(0);
  });
});

describe('extraction and reconciliation', () => {
  test('ADD: a new fact becomes a memory with provenance, the extractor as actor, and a logged LLM call', async () => {
    const { user, token } = await createUser();
    const { conversation, say } = await chat(token);
    const message = await say('I am allergic to peanuts since 2019');
    await worker.drain();

    const [memory] = await current(user._id);
    expect(memory).toMatchObject({ content: 'Is allergic to peanuts', importance: 5, confidence: 0.95, sensitivity: 'special', tags: ['allergy'] });
    expect(memory.validFrom.toISOString()).toBe('2019-01-01T00:00:00.000Z'); // the stated date is the valid time
    expect(memory.sourceMessageIds.map(String)).toEqual([message._id]);
    expect(String(memory.conversationId)).toBe(conversation._id);

    const [entry] = await AuditLog.find({ memoryId: memory._id }).lean();
    expect(entry).toMatchObject({ action: 'create', actorId: null, via: 'extractor' });
    expect(entry.reason).toMatch(/No similar memory/);

    // No similar memory existed, so reconciliation needed no LLM call: one call (extract) in total
    const calls = await LlmCall.find().lean();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ task: 'extract', provider: 'mock', model: 'claude-opus-5-5', promptId: 'extract.v1', status: 'ok', tokensEstimated: true, costUsd: 0 });
    expect(String(calls[0].userId)).toBe(String(user._id));
    expect(calls[0].inputTokens).toBeGreaterThan(0);

    const job = await Job.findOne().lean();
    expect(job.result.decisions).toEqual([expect.objectContaining({ action: 'ADD', category: 'Health', topic: 'allergy' })]);
  });

  test('chit-chat produces no memory', async () => {
    const { user, token } = await createUser();
    const { say } = await chat(token);
    await say('Thanks, that was helpful! What is the weather like on Mars?');
    await worker.drain();
    expect(await Memory.countDocuments({ userId: user._id })).toBe(0);
    expect((await Job.findOne().lean()).result).toMatchObject({ candidates: 0, decisions: [] });
  });

  test('SUPERSEDE: moving city closes the old version and starts a new one (Stage 2 version chain)', async () => {
    const { user, token } = await createUser();
    const { say } = await chat(token);
    await say('I live in Pune since 2020');
    await worker.drain();
    const second = await say('Big news: I moved to Mumbai in March 2024');
    await worker.drain();

    const all = await Memory.find({ userId: user._id }).sort({ recordedAt: 1 }).lean();
    expect(all).toHaveLength(2);
    const [pune, mumbai] = all;
    expect(pune.content).toBe('Lives in Pune');
    expect(mumbai.content).toBe('Lives in Mumbai');
    expect(String(mumbai.supersedes)).toBe(String(pune._id));
    expect(String(pune.supersededBy)).toBe(String(mumbai._id));
    expect(pune.validTo.toISOString()).toBe('2024-03-01T00:00:00.000Z'); // valid time ends when the new fact starts
    expect(pune.retractedAt).toBeNull(); // still believed: it WAS true
    expect(mumbai.sourceMessageIds.map(String)).toEqual([second._id]);

    // As-of query: in 2023 the user lived in Pune
    const asOf = await api(token).get('/api/memories?asOf=2023-06-01');
    expect(asOf.body.memories.map((m) => m.content)).toEqual(['Lives in Pune']);

    const audit = await AuditLog.findOne({ memoryId: mumbai._id }).lean();
    expect(audit).toMatchObject({ action: 'supersede', via: 'extractor', actorId: null });
    expect(await LlmCall.countDocuments({ task: 'reconcile', promptId: 'reconcile.v1' })).toBe(1);
  });

  test('NOOP: repeating a known fact writes nothing', async () => {
    const { user, token } = await createUser();
    const { say } = await chat(token);
    await say('I work at Infosys');
    await worker.drain();
    await say('As I said, I work at Infosys');
    await worker.drain();
    expect(await Memory.countDocuments({ userId: user._id })).toBe(1);
    const jobs = await Job.find().sort({ _id: 1 }).lean();
    expect(jobs[1].result.decisions[0]).toMatchObject({ action: 'NOOP', memoryId: null });
    expect(await AuditLog.countDocuments()).toBe(1);
  });

  test('UPDATE: more detail on the same fact is a correction that keeps both source messages', async () => {
    const { user, token } = await createUser();
    const { say } = await chat(token);
    const first = await say('I love coffee');
    await worker.drain();
    const second = await say('Honestly I love black coffee');
    await worker.drain();

    const [now] = await current(user._id);
    expect(now.content).toBe('Likes black coffee');
    expect(now.sourceMessageIds.map(String)).toEqual([first._id, second._id]);
    const old = await Memory.findById(now.supersedes).lean();
    expect(old.retractedAt).not.toBeNull(); // a correction retracts the less precise version
    expect(old.validFrom.getTime()).toBe(now.validFrom.getTime()); // and the new one takes over its valid time
  });

  test('ADD for a second value of a many-valued topic (two allergies are both kept)', async () => {
    const { user, token } = await createUser();
    const { say } = await chat(token);
    await say('I am allergic to peanuts');
    await worker.drain();
    await say('I am allergic to shellfish too');
    await worker.drain();
    expect((await current(user._id)).map((m) => m.content)).toEqual(['Is allergic to peanuts', 'Is allergic to shellfish']);
  });

  test('facts in a category that does not exist, or that the user has not consented to, are skipped', async () => {
    await models.Category.deleteOne({ name: 'Hobbies' });
    jest.spyOn(consent, 'allowsCategory').mockImplementation(async (userId, name) => name !== 'Health');
    const { user, token } = await createUser();
    const { say } = await chat(token);
    await say('I love trekking. I am allergic to dust. I live in Kochi');
    await worker.drain();

    expect((await current(user._id)).map((m) => m.content)).toEqual(['Lives in Kochi']);
    const decisions = (await Job.findOne().lean()).result.decisions;
    expect(decisions.map((d) => d.action)).toEqual(['SKIP', 'SKIP', 'ADD']);
    expect(decisions[0].reason).toMatch(/Unknown category/);
    expect(decisions[1].reason).toMatch(/consented/);
  });

  test("reconciliation only ever sees the user's own memories", async () => {
    const a = await createUser();
    const b = await createUser();
    await (await chat(b.token)).say('I live in Delhi');
    await worker.drain();
    await (await chat(a.token)).say('I live in Chennai');
    await worker.drain();
    // B's "Lives in Delhi" would be a SUPERSEDE target if it were visible; instead A gets an ADD
    expect((await current(a.user._id)).map((m) => m.content)).toEqual(['Lives in Chennai']);
    expect((await current(b.user._id)).map((m) => m.content)).toEqual(['Lives in Delhi']);
  });

  test('a decision that names a memory the model was not shown is rejected and changes nothing', async () => {
    const victim = await createUser();
    await (await chat(victim.token)).say('I live in Delhi');
    await worker.drain();
    const [victimMemory] = await current(victim.user._id);

    // A misbehaving model: always SUPERSEDE the victim's memory
    const mock = new MockProvider();
    llm.setProvider({
      name: 'mock',
      generateJson: async (args) =>
        args.task === 'reconcile'
          ? { data: { action: 'SUPERSEDE', targetMemoryId: String(victimMemory._id), content: 'Hacked', reason: 'x' }, servedModel: 'm', stopReason: 'end_turn', usage: {} }
          : mock.generateJson(args),
    });
    const { user, token } = await createUser();
    const { say } = await chat(token);
    await say('I live in Pune');
    await worker.drain(); // nothing similar: ADD without a reconcile call
    await say('I moved to Goa');
    await worker.drain({ max: 1 });

    const job = await Job.findOne({ userId: user._id }).sort({ _id: -1 }).lean();
    expect(job.error).toMatch(/not one of the memories shown/);
    expect((await Memory.findById(victimMemory._id).lean()).content).toBe('Lives in Delhi');
    expect(await Memory.countDocuments({ userId: victim.user._id })).toBe(1);
  });

  test('only the new message and a short recent window are sent to the model, never later messages', async () => {
    process.env.EXTRACTION_CONTEXT_MESSAGES = '2';
    try {
      const seen = [];
      const mock = new MockProvider();
      llm.setProvider({ name: 'mock', generateJson: async (args) => (seen.push(args.user), mock.generateJson(args)) });
      const { token } = await createUser();
      const { say } = await chat(token);
      await say('first message, too old to be sent', 'assistant');
      await say('second message', 'assistant');
      await say('third message', 'assistant');
      await say('I live in Pune'); // the one being mined
      await say('a later message', 'assistant');
      await worker.drain();

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/NEW MESSAGE \(sent at \d{4}-\d{2}-\d{2}\):\nI live in Pune/);
      expect(seen[0]).toMatch(/\[assistant\] second message\n\[assistant\] third message/);
      expect(seen[0]).not.toMatch(/too old|later message/);
    } finally {
      delete process.env.EXTRACTION_CONTEXT_MESSAGES;
    }
  });

  test('running the same message twice (a retried job) does not store the fact twice', async () => {
    const { user, token } = await createUser();
    const { conversation, say } = await chat(token);
    const message = await say('I am learning German');
    await worker.drain();
    const again = await extraction.processMessage({ userId: user._id, messageId: message._id, conversationId: conversation._id });
    expect(again.decisions[0]).toMatchObject({ action: 'SKIP', reason: expect.stringMatching(/Already stored/) });
    expect(await Memory.countDocuments({ userId: user._id })).toBe(1);
  });
});

describe('job queue', () => {
  test('a temporary failure is retried with back-off, then the job fails after maxAttempts', async () => {
    const { token } = await createUser();
    const { say } = await chat(token);
    const message = await say('I live in Pune [mock:fail]');

    const first = await worker.runOnce();
    expect(first.outcome).toBe('retry');
    let job = await Job.findById(message.extractionJobId).lean();
    expect(job).toMatchObject({ status: 'pending', attempts: 1, error: expect.stringMatching(/simulated temporary failure/) });

    await worker.drain();
    job = await Job.findById(message.extractionJobId).lean();
    expect(job).toMatchObject({ status: 'failed', attempts: 3 });
    expect(job.finishedAt).not.toBeNull();
    // Every failed attempt is in the call log too
    expect(await LlmCall.countDocuments({ status: 'error' })).toBe(3);
  });

  test('a refusal is not retried', async () => {
    const { token } = await createUser();
    const { say } = await chat(token);
    const message = await say('[mock:refuse]');
    await worker.drain();
    expect(await Job.findById(message.extractionJobId).lean()).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await LlmCall.findOne().lean()).toMatchObject({ status: 'refusal', stopReason: 'refusal' });
  });

  test('two workers can never claim the same job', async () => {
    const { token } = await createUser();
    await (await chat(token)).say('I live in Pune');
    const claims = await Promise.all([jobService.claimNext('w1'), jobService.claimNext('w2'), jobService.claimNext('w3')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  test('a job whose worker died goes back to pending after the lock timeout', async () => {
    const { token } = await createUser();
    await (await chat(token)).say('I live in Pune');
    const job = await jobService.claimNext('dead-worker');
    await Job.updateOne({ _id: job._id }, { $set: { lockedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await jobService.releaseStaleJobs();
    expect(await Job.findById(job._id).lean()).toMatchObject({ status: 'pending', lockedBy: null });
    expect(await worker.drain()).toBe(1);
    expect((await Job.findById(job._id).lean()).status).toBe('done');
  });

  test('a job whose message was deleted finishes without doing anything; deleting a conversation deletes its jobs', async () => {
    const { user, token } = await createUser();
    const { conversation, say } = await chat(token);
    const message = await say('I live in Pune');
    await Message.deleteOne({ _id: message._id });
    await worker.drain();
    expect((await Job.findById(message.extractionJobId).lean()).result.skipped).toMatch(/no longer exists/);
    expect(await Memory.countDocuments({ userId: user._id })).toBe(0);

    await say('I live in Kochi');
    await api(token).delete(`/api/conversations/${conversation._id}`);
    expect(await Job.countDocuments({ 'payload.conversationId': conversation._id })).toBe(0);
  });
});

describe('GET /api/jobs', () => {
  test("lists and shows the caller's own jobs only", async () => {
    const a = await createUser();
    const b = await createUser();
    const message = await (await chat(a.token)).say('I live in Pune');
    await (await chat(b.token)).say('I live in Delhi');
    await worker.drain();

    const list = await api(a.token).get('/api/jobs?status=done');
    expect(list.status).toBe(200);
    expect(list.body.jobs).toHaveLength(1);
    expect(list.body.jobs[0]._id).toBe(message.extractionJobId);

    const one = await api(a.token).get(`/api/jobs/${message.extractionJobId}`);
    expect(one.body.result.decisions[0].action).toBe('ADD');
    expect((await api(b.token).get(`/api/jobs/${message.extractionJobId}`)).status).toBe(404);
    expect((await api(a.token).get('/api/jobs?status=stuck')).status).toBe(400);
    expect((await api().get('/api/jobs')).status).toBe(401);
  });
});
