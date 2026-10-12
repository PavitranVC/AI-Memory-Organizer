/**
 * Brings any older database up to the current schema by running every stage's migration in order.
 * Each migration is safe to run more than once, so this is too.  Run with:  npm run migrate
 */
require('dotenv').config();
const mongoose = require('mongoose');

const stage1 = require('./migrate-stage1');
const stage2 = require('./migrate-stage2');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';

async function main() {
  await mongoose.connect(MONGO_URI);
  const result = {
    stage1: await stage1.migrate({ defaultPassword: process.env.MIGRATE_DEFAULT_PASSWORD }),
    stage2: await stage2.migrate(),
  };
  console.log('Migration complete:', JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
