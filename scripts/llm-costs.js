// Cost report from the llmcalls collection: one row per provider, model, task and prompt version.
//   npm run llm:costs                  real calls only
//   npm run llm:costs -- --include-mock   also the mock's rows (estimated tokens, $0)
require('dotenv').config();
const mongoose = require('mongoose');
const LlmCall = require('../models/LlmCall');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';

async function main() {
  await mongoose.connect(MONGO_URI);
  const match = process.argv.includes('--include-mock') ? {} : { provider: { $ne: 'mock' } };
  // $group sums the tokens per (provider, model, task, prompt); the cache hit rate is the share of the
  // prompt that was read from the cache instead of being processed again.
  const rows = await LlmCall.aggregate([
    { $match: match },
    {
      $group: {
        _id: { provider: '$provider', model: { $ifNull: ['$servedModel', '$model'] }, task: '$task', prompt: '$promptId' },
        calls: { $sum: 1 },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'ok'] }, 0, 1] } },
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
        cacheReadTokens: { $sum: '$cacheReadTokens' },
        cacheWriteTokens: { $sum: '$cacheWriteTokens' },
        costUsd: { $sum: { $ifNull: ['$costUsd', 0] } },
        unpriced: { $sum: { $cond: [{ $eq: ['$costUsd', null] }, 1, 0] } },
        avgLatencyMs: { $avg: '$latencyMs' },
        estimated: { $max: '$tokensEstimated' },
      },
    },
    {
      $addFields: {
        cacheHitRate: {
          $let: {
            vars: { prompt: { $add: ['$inputTokens', '$cacheReadTokens', '$cacheWriteTokens'] } },
            in: { $cond: [{ $eq: ['$$prompt', 0] }, null, { $round: [{ $divide: ['$cacheReadTokens', '$$prompt'] }, 3] }] },
          },
        },
      },
    },
    { $sort: { '_id.provider': 1, '_id.task': 1 } },
  ]);
  if (rows.length === 0) console.log(`No ${match.provider ? 'real ' : ''}LLM calls in ${mongoose.connection.name}.`);
  for (const r of rows) {
    const k = r._id;
    console.log(`${k.provider}/${k.model} ${k.task} (${k.prompt}): ${r.calls} calls (${r.failed} not ok), input ${r.inputTokens}, output ${r.outputTokens}, ` +
      `cache read ${r.cacheReadTokens}, cache write ${r.cacheWriteTokens}, cache hit rate ${r.cacheHitRate ?? '-'}, ` +
      `cost $${r.costUsd.toFixed(4)}${r.unpriced ? ` (+${r.unpriced} unpriced)` : ''}, avg ${Math.round(r.avgLatencyMs)} ms${r.estimated ? ' [mock: estimated tokens]' : ''}`);
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('llm:costs failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
