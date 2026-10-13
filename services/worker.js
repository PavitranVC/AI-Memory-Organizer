const jobService = require('./jobService');
const extraction = require('./extractionService');

// What each job type does
const HANDLERS = {
  extract: (job) =>
    extraction.processMessage({
      userId: job.userId,
      messageId: job.payload.messageId,
      conversationId: job.payload.conversationId,
      jobId: job._id,
    }),
};

const runOnce = () => jobService.runOnce(HANDLERS);

// Runs jobs until the queue has nothing due. Returns how many ran. (Used by tests and "npm run worker -- --drain".)
async function drain({ max = 1000 } = {}) {
  let count = 0;
  while (count < max) {
    const ran = await runOnce();
    if (!ran) break;
    count += 1;
  }
  return count;
}

// A polling loop: one job at a time (so two jobs of the same user never reconcile against each other at
// once), sleeping pollMs when the queue is empty. Returns a stop() function that resolves once the current
// job has finished.
function start({ pollMs = Number(process.env.WORKER_POLL_MS) || 2000, log = console } = {}) {
  let stopped = false;
  let timer = null;
  let wake = null;
  const loop = (async () => {
    while (!stopped) {
      try {
        const ran = await runOnce();
        if (ran) {
          log.log(`[worker] job ${ran.job._id} (${ran.job.type}) -> ${ran.outcome}${ran.error ? `: ${ran.error}` : ''}`);
          continue;
        }
      } catch (err) {
        log.error(`[worker] ${err.message}`); // e.g. the database is unreachable: wait and try again
      }
      await new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, pollMs);
      });
    }
  })();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    if (wake) wake();
    await loop;
  };
}

module.exports = { HANDLERS, runOnce, drain, start };
