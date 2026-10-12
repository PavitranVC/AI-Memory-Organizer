// Counts for docs/DATASETS.md, from a real run (CLAUDE.md: every number comes from a committed script).
//   npm run data:stats             file + database counts, written to results/stage5-dataset-stats.json
//   npm run data:stats -- --no-db  only the LoCoMo file
// It reads the LoCoMo file and the database and prints COUNTS only, never dataset text.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const mongoose = require('mongoose');
const { normaliseEvidence, QUESTION_TYPES } = require('../../services/datasets/locomo');
const User = require('../../models/User');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Memory = require('../../models/Memory');
const EvalItem = require('../../models/EvalItem');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/aimemory';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const OUT = path.join(__dirname, '..', '..', 'results', 'stage5-dataset-stats.json');

const pct = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : null);

// Facts about the LoCoMo file itself, including the check behind the category names: if category 2 is
// "temporal", most of its questions should start with "When"; if 1 is "multi-hop", most should cite more than
// one dialog turn as evidence; category 5 should be the one with adversarial answers.
function locomoFileStats(file) {
  const raw = fs.readFileSync(file);
  const samples = JSON.parse(raw.toString('utf8'));
  const turns = [];
  const diaIds = new Set();
  let sessions = 0;
  for (const s of samples) {
    for (const [key, value] of Object.entries(s.conversation)) {
      if (!/^session_\d+$/.test(key) || !Array.isArray(value) || !value.length) continue;
      sessions += 1;
      for (const t of value) {
        turns.push(t);
        diaIds.add(`${s.sample_id}|${t.dia_id}`);
      }
    }
  }
  const qa = samples.flatMap((s) => s.qa.map((q) => ({ ...q, sampleId: s.sample_id })));
  const byCategory = {};
  for (const [category, name] of Object.entries(QUESTION_TYPES)) {
    const items = qa.filter((q) => String(q.category) === category);
    byCategory[category] = {
      name,
      questions: items.length,
      startsWithWhenPct: pct(items.filter((q) => /^when\b/i.test(q.question)).length, items.length),
      multiEvidencePct: pct(items.filter((q) => normaliseEvidence(q.evidence).ids.length > 1).length, items.length),
      hasAdversarialAnswerPct: pct(items.filter((q) => q.adversarial_answer !== undefined).length, items.length),
      noAnswerPct: pct(items.filter((q) => q.answer === undefined).length, items.length),
    };
  }
  let evidenceRefs = 0;
  let unresolved = 0;
  for (const q of qa) {
    const { ids, invalid } = normaliseEvidence(q.evidence);
    evidenceRefs += ids.length + invalid.length;
    unresolved += invalid.length + ids.filter((id) => !diaIds.has(`${q.sampleId}|${id}`)).length;
  }
  return {
    file: path.relative(process.cwd(), file),
    bytes: raw.length,
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    samples: samples.length,
    sessions,
    turns: turns.length,
    imageTurns: turns.filter((t) => t.blip_caption).length,
    questions: qa.length,
    questionsWithoutCategory: qa.filter((q) => !QUESTION_TYPES[q.category]).length,
    byCategory,
    evidenceRefsAfterNormalising: evidenceRefs,
    evidenceRefsUnresolved: unresolved,
  };
}

async function databaseStats() {
  await mongoose.connect(MONGO_URI);
  const byDataset = async (Model) => Object.fromEntries((await Model.aggregate([{ $group: { _id: '$dataset', n: { $sum: 1 } } }, { $sort: { _id: 1 } }])).map((r) => [r._id || '(app data, no label)', r.n]));
  const stats = {
    database: mongoose.connection.name,
    users: await byDataset(User),
    conversations: await byDataset(Conversation),
    messages: await byDataset(Message),
    memories: await byDataset(Memory),
    evalItems: await byDataset(EvalItem),
    evalItemsByType: Object.fromEntries((await EvalItem.aggregate([{ $group: { _id: '$questionType', n: { $sum: 1 } } }, { $sort: { _id: 1 } }])).map((r) => [r._id, r.n])),
    evalItemsWithUnresolvedEvidence: await EvalItem.countDocuments({ 'unresolvedEvidence.0': { $exists: true } }),
    evalItemsWithNoResolvedEvidence: await EvalItem.countDocuments({ evidenceMessageIds: { $size: 0 } }),
  };
  await mongoose.disconnect();
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const file = path.join(DATA_DIR, 'locomo', 'locomo10.json');
  const report = {
    command: `npm run data:stats${args.length ? ` -- ${args.join(' ')}` : ''}`,
    commit: execSync('git rev-parse --short HEAD').toString().trim(),
    date: new Date().toISOString(),
    dataset: 'LoCoMo (benchmark) file and database counts by dataset label',
    locomoFile: fs.existsSync(file) ? locomoFileStats(file) : 'not downloaded',
    database: args.includes('--no-db') ? 'skipped (--no-db)' : await databaseStats(),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  const f = report.locomoFile;
  if (typeof f === 'object') console.log(`LoCoMo file: ${f.samples} samples, ${f.sessions} sessions, ${f.turns} turns, ${f.questions} questions, ${f.evidenceRefsUnresolved} unresolved evidence ids`);
  if (typeof report.database === 'object') console.log(`Database ${report.database.database}: messages ${JSON.stringify(report.database.messages)}, memories ${JSON.stringify(report.database.memories)}`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});
