// Embeds every believed memory version that has no vector from the configured model (EMBEDDING_PROVIDER):
// memories from before Stage 4, from the seed or a dataset loader, or written while the provider was down.
//   npm run embed:backfill                         all memories
//   npm run embed:backfill -- --dataset synthetic  only one dataset label (real | benchmark | synthetic)
//   npm run embed:backfill -- --batch 50
// Safe to re-run. With EMBEDDING_PROVIDER=voyage this costs money: check the count it prints first.
require('dotenv').config();
const mongoose = require('mongoose');
const { backfillEmbeddings } = require('../services/embeddings/backfill');
const { DATASETS } = require('../models/dataset');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';

function option(args, name) {
  return args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const dataset = option(args, '--dataset');
  if (dataset !== undefined && !DATASETS.includes(dataset)) throw new Error(`--dataset must be one of: ${DATASETS.join(', ')}`);
  const batchSize = Number(option(args, '--batch') || 100);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128) throw new Error('--batch must be a whole number from 1 to 128');

  await mongoose.connect(MONGO_URI);
  let lastTenth = -1;
  const summary = await backfillEmbeddings({
    batchSize,
    filter: dataset ? { dataset } : {},
    // One progress line per 10%, never one per batch
    onProgress: ({ embedded, total }) => {
      const tenth = Math.floor((embedded / total) * 10);
      if (tenth !== lastTenth) {
        lastTenth = tenth;
        console.log(`embedded ${embedded} / ${total}`);
      }
    },
  });
  console.log(JSON.stringify(summary));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});
