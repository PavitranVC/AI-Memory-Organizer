// The extraction worker: takes jobs from the "jobs" collection and runs the LLM pipeline.
//   npm run worker              keep running, polling every WORKER_POLL_MS (default 2000 ms)
//   npm run worker -- --drain   run every job that is due, then exit
// The provider comes from LLM_PROVIDER (mock by default, so this costs nothing unless you set "anthropic").
require('dotenv').config();
const mongoose = require('mongoose');
const worker = require('../services/worker');
const { llmConfig } = require('../services/llm/config');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';

async function main() {
  const config = llmConfig();
  await mongoose.connect(MONGO_URI);
  console.log(`[worker] connected to ${mongoose.connection.name}, LLM provider: ${config.provider}`);
  if (process.argv.includes('--drain')) {
    const count = await worker.drain();
    console.log(`[worker] ran ${count} job(s); queue has nothing due`);
    await mongoose.disconnect();
    return;
  }
  const stop = worker.start();
  const shutdown = async () => {
    console.log('[worker] stopping after the current job');
    await stop();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (err) => {
  console.error('[worker] failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
