const os = require('os');
const Job = require('../models/Job');
const { badRequest, notFound } = require('./errors');
const { toObjectId } = require('./ids');
const { paginate } = require('./pagination');

// A small job queue in MongoDB. Producers insert "pending" jobs; a worker CLAIMS one with an atomic
// findOneAndUpdate (pending -> running), so two workers can never take the same job.
const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
const retryDelayMs = () => num(process.env.JOB_RETRY_DELAY_MS, 5000);
const lockTimeoutMs = () => num(process.env.JOB_LOCK_TIMEOUT_MS, 5 * 60 * 1000);
const workerId = () => `${os.hostname()}:${process.pid}`;

// Extraction runs only for the user's own messages (facts about the user) and can be switched off
const extractionEnabled = () => process.env.EXTRACTION_ENABLED !== 'false';

// Called inside the transaction that inserts the message (transactional outbox): both are saved or neither
async function enqueueExtraction({ userId, messageId, conversationId }, session) {
  const [job] = await Job.create([{ type: 'extract', userId, payload: { messageId, conversationId } }], { session });
  return job;
}

// A worker that died leaves its job "running". After the lock timeout the job goes back to "pending"
// (or to "failed" if it has used all its attempts), so it is never lost.
async function releaseStaleJobs(now = new Date()) {
  const stale = { status: 'running', lockedAt: { $lt: new Date(now.getTime() - lockTimeoutMs()) } };
  const update = { lockedAt: null, lockedBy: null, error: 'The worker stopped before finishing (lock expired)' };
  await Job.updateMany({ ...stale, $expr: { $gte: ['$attempts', '$maxAttempts'] } }, { $set: { ...update, status: 'failed', finishedAt: now } });
  await Job.updateMany(stale, { $set: { ...update, status: 'pending', runAt: now } });
}

// Atomically takes the oldest due job. Index { status, runAt }: equality on status, then sort and range on runAt.
async function claimNext(worker = workerId(), now = new Date()) {
  return Job.findOneAndUpdate(
    { status: 'pending', runAt: { $lte: now } },
    { $set: { status: 'running', lockedAt: now, lockedBy: worker }, $inc: { attempts: 1 } },
    { sort: { runAt: 1 }, new: true }
  );
}

async function complete(job, result) {
  await Job.updateOne(
    { _id: job._id, status: 'running', lockedBy: job.lockedBy },
    { $set: { status: 'done', result, error: null, lockedAt: null, finishedAt: new Date() } }
  );
}

// Retry with exponential back-off unless the error cannot be fixed by retrying (a refusal, a bad request)
// or the job has used all its attempts.
async function fail(job, err) {
  const clientError = err.status >= 400 && err.status < 500 && err.status !== 409; // 409 = concurrent change: retry
  const retryable = err.retryable !== false && !clientError;
  const now = new Date();
  const again = retryable && job.attempts < job.maxAttempts;
  await Job.updateOne(
    { _id: job._id, status: 'running', lockedBy: job.lockedBy },
    {
      $set: {
        status: again ? 'pending' : 'failed',
        error: String(err.message || err).slice(0, 500),
        lockedAt: null,
        lockedBy: null,
        runAt: again ? new Date(now.getTime() + retryDelayMs() * 2 ** (job.attempts - 1)) : job.runAt,
        finishedAt: again ? null : now,
      },
    }
  );
  return again ? 'retry' : 'failed';
}

// Claims and runs one job. Returns null when the queue is empty, otherwise { job, outcome }.
async function runOnce(handlers, worker = workerId()) {
  await releaseStaleJobs();
  const job = await claimNext(worker);
  if (!job) return null;
  const handler = handlers[job.type];
  try {
    if (!handler) throw Object.assign(new Error(`No handler for job type "${job.type}"`), { retryable: false });
    const result = await handler(job);
    await complete(job, result);
    return { job, outcome: 'done', result };
  } catch (err) {
    return { job, outcome: await fail(job, err), error: err.message };
  }
}

// --- Read-only endpoints: a user sees only their own jobs ---

async function listJobs(userId, query = {}) {
  const filter = { userId };
  if (query.status !== undefined) {
    if (!Job.STATUSES.includes(query.status)) throw badRequest(`status must be one of: ${Job.STATUSES.join(', ')}`);
    filter.status = query.status;
  }
  const { items, limit, nextCursor } = await paginate(Job, filter, query);
  return { count: items.length, limit, nextCursor, jobs: items };
}

async function getJob(userId, id) {
  const job = await Job.findOne({ _id: toObjectId(id), userId }).lean();
  if (!job) throw notFound('Job not found');
  return job;
}

module.exports = { extractionEnabled, enqueueExtraction, releaseStaleJobs, claimNext, complete, fail, runOnce, listJobs, getJob, workerId };
