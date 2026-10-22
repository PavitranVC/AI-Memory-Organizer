// Counts for docs/DATASETS.md from the LongMemEval file, from a real run (CLAUDE.md: every number comes from a
// committed script). Prints and writes COUNTS only, never dataset text.
//   npm run data:stats:longmemeval                  the 277 MB main file (data/longmemeval/longmemeval_s_cleaned.json)
//   npm run data:stats:longmemeval -- --file path   another copy, e.g. longmemeval_oracle.json
// Writes results/stage5b-longmemeval-stats-<file name>.json. No database is needed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { QUESTION_TYPES, isAbstention, parseLongMemEvalDate } = require('../../services/datasets/longmemeval');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const MAX_CONTENT = 10000; // Message.content limit; the loader cuts longer turns

const stat = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const sum = numbers.reduce((a, b) => a + b, 0);
  return { min: sorted[0], mean: Math.round((10 * sum) / numbers.length) / 10, max: sorted[sorted.length - 1] };
};

function fileStats(file) {
  const raw = fs.readFileSync(file);
  const items = JSON.parse(raw.toString('utf8'));
  const turns = items.flatMap((q) => q.haystack_sessions.flat());
  const byType = {};
  for (const type of Object.keys(QUESTION_TYPES)) {
    const ofType = items.filter((q) => q.question_type === type);
    byType[type] = {
      category: QUESTION_TYPES[type],
      questions: ofType.length,
      abstention: ofType.filter((q) => isAbstention(q.question_id)).length,
      withoutEvidenceTurns: ofType.filter((q) => !q.haystack_sessions.flat().some((t) => t.has_answer)).length,
    };
  }
  const outOfOrder = items.filter((q) => q.haystack_dates.some((d, i, all) => i > 0 && parseLongMemEvalDate(d) < parseLongMemEvalDate(all[i - 1])));
  return {
    file: path.relative(process.cwd(), file),
    bytes: raw.length,
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    questions: items.length,
    uniqueQuestionIdsIgnoringCase: new Set(items.map((q) => q.question_id.toLowerCase())).size,
    questionsWithUnknownType: items.filter((q) => !QUESTION_TYPES[q.question_type]).length,
    byType,
    abstention: items.filter((q) => isAbstention(q.question_id)).length,
    sessionsPerQuestion: stat(items.map((q) => q.haystack_sessions.length)),
    turnsPerQuestion: stat(items.map((q) => q.haystack_sessions.flat().length)),
    turns: turns.length,
    userTurns: turns.filter((t) => t.role === 'user').length,
    assistantTurns: turns.filter((t) => t.role === 'assistant').length,
    turnsWithEvidenceFlag: turns.filter((t) => t.has_answer === true).length,
    emptyTurnsSkippedByLoader: turns.filter((t) => !String(t.content || '').trim()).length,
    turnsOverMessageLimit: turns.filter((t) => String(t.content).length > MAX_CONTENT).length,
    userTurnsOverMessageLimit: turns.filter((t) => t.role === 'user' && String(t.content).length > MAX_CONTENT).length,
    // reduce, not Math.max(...list): spreading 247k numbers overflows the call stack
    longestTurnChars: turns.reduce((max, t) => Math.max(max, String(t.content).length), 0),
    questionsWithSessionsOutOfDateOrder: outOfOrder.length,
    questionsWithRepeatedSessionId: items.filter((q) => new Set(q.haystack_session_ids).size !== q.haystack_session_ids.length).length,
    questionsWithMismatchedHaystackLengths: items.filter((q) => q.haystack_sessions.length !== q.haystack_dates.length || q.haystack_sessions.length !== q.haystack_session_ids.length).length,
  };
}

function main() {
  const args = process.argv.slice(2);
  const file = args.includes('--file') ? args[args.indexOf('--file') + 1] : path.join(DATA_DIR, 'longmemeval', 'longmemeval_s_cleaned.json');
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Run "npm run data:download -- longmemeval" first.`);
  const report = {
    command: `npm run data:stats:longmemeval${args.length ? ` -- ${args.join(' ')}` : ''}`,
    commit: execSync('git rev-parse --short HEAD').toString().trim(),
    date: new Date().toISOString(),
    dataset: 'LongMemEval (benchmark), file counts only',
    file: fileStats(file),
  };
  const out = path.join(__dirname, '..', '..', 'results', `stage5b-longmemeval-stats-${path.basename(file, '.json')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const f = report.file;
  console.log(`${f.file}: ${f.questions} questions (${f.abstention} abstention), ${f.turns} turns, ${f.sessionsPerQuestion.mean} sessions per question on average, ${f.turnsOverMessageLimit} turns over the ${MAX_CONTENT}-character message limit, ${f.questionsWithSessionsOutOfDateOrder} questions with sessions out of date order`);
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
