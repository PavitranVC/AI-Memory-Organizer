// Loads LongMemEval (downloaded by "npm run data:download -- longmemeval") into MongoDB as benchmark users,
// conversations, messages and evalitems. One user per question, because every question has its own history.
//   npm run data:load:longmemeval -- --types knowledge-update,temporal-reasoning --per-type 5   a small pilot
//   npm run data:load:longmemeval -- --ids gpt4_2655b836                                         named questions
//   npm run data:load:longmemeval                                                                all 500 (slow, large)
//   npm run data:load:longmemeval -- --reset      replace questions that are already loaded
//   npm run data:load:longmemeval -- --file path  another copy (default data/longmemeval/longmemeval_s_cleaned.json;
//                                                 longmemeval_oracle.json is the 15 MB evidence-only version)
//   --seed N   the seed of the --per-type choice (default 1)
// Loaded users get the SEED_PASSWORD (default DevPassword123) so you can log in as one for a demo.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { loadLongMemEval, selectQuestions } = require('../../services/datasets/longmemeval');
const { hashPassword } = require('../../services/authService');
const User = require('../../models/User');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const EvalItem = require('../../models/EvalItem');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const list = (name) => (option(name) ? option(name).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  const file = option('--file') || path.join(DATA_DIR, 'longmemeval', 'longmemeval_s_cleaned.json');
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Run "npm run data:download -- longmemeval" first.`);
  // Parsed in this process only; nothing from the file is printed except ids and counts. The small and medium
  // files are one JSON document of a few hundred MB at most; the 2.7 GB "m" file does not fit in one string
  // and is not supported.
  const size = fs.statSync(file).size;
  if (size > 500 * 1024 * 1024) throw new Error(`${file} is ${(size / 1e6).toFixed(0)} MB: too large to parse as one JSON document. Use longmemeval_s_cleaned.json or the oracle file.`);
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));

  const perType = option('--per-type') ? Number(option('--per-type')) : undefined;
  if (perType !== undefined && !(Number.isInteger(perType) && perType > 0)) throw new Error('--per-type needs a positive whole number');
  const seed = option('--seed') ? Number(option('--seed')) : 1;
  const questions = selectQuestions(all, { types: list('--types'), perType, ids: list('--ids'), seed });
  console.log(`${file}: ${all.length} questions in the file, ${questions.length} selected`);

  await mongoose.connect(MONGO_URI);
  await Promise.all([User.init(), Conversation.init(), Message.init(), EvalItem.init()]);
  const passwordHash = await hashPassword(process.env.SEED_PASSWORD || 'DevPassword123');
  const summary = await loadLongMemEval(questions, {
    reset: args.includes('--reset'),
    passwordHash,
    onQuestion: (q) => console.log(`${q.questionId}: ${q.status}${q.messages !== undefined ? ` (${q.questionType}, ${q.conversations} sessions, ${q.messages} messages, ${q.evidence} evidence turns)` : ''}`),
  });
  console.log(JSON.stringify(summary));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});
