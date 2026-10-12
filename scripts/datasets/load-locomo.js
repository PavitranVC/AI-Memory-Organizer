// Loads LoCoMo (downloaded by "npm run data:download") into MongoDB as benchmark users, conversations,
// messages and evalitems.
//   npm run data:load:locomo                  load; samples already loaded are skipped
//   npm run data:load:locomo -- --reset       replace samples that are already loaded
//   npm run data:load:locomo -- --file path   another copy of locomo10.json
// Loaded users get the SEED_PASSWORD (default DevPassword123) so you can log in as one for a demo.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { loadLocomo } = require('../../services/datasets/locomo');
const { hashPassword } = require('../../services/authService');
const User = require('../../models/User');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const EvalItem = require('../../models/EvalItem');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

async function main() {
  const args = process.argv.slice(2);
  const file = args.includes('--file') ? args[args.indexOf('--file') + 1] : path.join(DATA_DIR, 'locomo', 'locomo10.json');
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Run "npm run data:download" first.`);
  // Parsed in this process only; nothing from the file is printed except ids and counts
  const samples = JSON.parse(fs.readFileSync(file, 'utf8'));

  await mongoose.connect(MONGO_URI);
  await Promise.all([User.init(), Conversation.init(), Message.init(), EvalItem.init()]);
  const passwordHash = await hashPassword(process.env.SEED_PASSWORD || 'DevPassword123');
  const summary = await loadLocomo(samples, {
    reset: args.includes('--reset'),
    passwordHash,
    onSample: (s) => console.log(`${s.sampleId}: ${s.status}${s.messages !== undefined ? ` (${s.conversations} sessions, ${s.messages} messages, ${s.evalItems} questions, ${s.unresolvedEvidence} unresolved evidence ids)` : ''}`),
  });
  console.log(JSON.stringify(summary));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});
