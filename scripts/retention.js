// Stage 7: erases "special"-sensitivity memory versions older than the retention period
// (see services/retentionService.js for why this is a scheduled job and not a TTL index).
//   npm run retention                    uses RETENTION_SPECIAL_DAYS (not set or 0 = off: prints that and exits)
//   npm run retention -- --days 365      overrides the period
//   npm run retention -- --dry-run       only counts what would be erased
// Schedule it daily, e.g. cron "17 3 * * *" or a Windows Task Scheduler task running "npm run retention".
require('dotenv').config();
const mongoose = require('mongoose');
const { retentionDays, purgeExpired } = require('../services/retentionService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';

function option(args, name) {
  return args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const days = retentionDays(option(args, '--days') !== undefined ? option(args, '--days') : process.env.RETENTION_SPECIAL_DAYS);
  const dryRun = args.includes('--dry-run');
  if (!(days > 0)) {
    console.log('Retention is off (set RETENTION_SPECIAL_DAYS or pass --days). Nothing was erased.');
    return;
  }
  await mongoose.connect(MONGO_URI);
  const summary = await purgeExpired({ days, dryRun, log: console.log });
  console.log(JSON.stringify(summary));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});
