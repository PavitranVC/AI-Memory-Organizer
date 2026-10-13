// Generates SYNTHETIC memories for the index and scale experiments (never for accuracy results).
//   npm run data:synthetic -- --memories 10000              10k memories, 1 synthetic user per 1,000
//   npm run data:synthetic -- --memories 100000 --users 50 --seed 7 --reset
//   npm run data:synthetic -- --remove                      delete all synthetic data
// --reset replaces earlier synthetic data (the generator refuses to mix two runs).
require('dotenv').config();
const mongoose = require('mongoose');
const { generateSynthetic, removeSynthetic } = require('../../services/datasets/synthetic');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';

function intOption(args, name, fallback) {
  if (!args.includes(name)) return fallback;
  const value = Number(String(args[args.indexOf(name) + 1]).replace(/_/g, ''));
  if (!Number.isInteger(value)) throw new Error(`${name} needs a whole number`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  await mongoose.connect(MONGO_URI);
  if (args.includes('--remove')) {
    console.log(JSON.stringify({ removed: await removeSynthetic() }));
  } else {
    const memories = intOption(args, '--memories', 10000);
    let lastTenth = -1;
    const summary = await generateSynthetic({
      memories,
      users: intOption(args, '--users', undefined),
      seed: intOption(args, '--seed', 42),
      batchSize: intOption(args, '--batch', 5000),
      reset: args.includes('--reset'),
      // One progress line per 10%, so a 1M run prints 10 lines, not 200
      onProgress: ({ inserted, total }) => {
        const tenth = Math.floor((inserted / total) * 10);
        if (tenth !== lastTenth) {
          lastTenth = tenth;
          console.log(`inserted ${inserted} / ${total}`);
        }
      },
    });
    console.log(JSON.stringify({ dataset: 'synthetic', ...summary }));
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});
