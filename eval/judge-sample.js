// Builds ONE blind labelling sheet for the LLM judge from ALL finished LoCoMo samples (not one sample's 50 rows).
//   npm run eval:judge-sample                      5 rows from each sample, 50 in all, seed 11
//   npm run eval:judge-sample -- --per-sample 6 --seed 11 --prefix stage6-locomo-ollama-conv-
// Writes results/stage6-locomo-judge-validation/: judge_validation.csv (what you label: question, gold answer,
// candidate answer; NO system name and NO judge verdict), judge_validation_key.csv (the judge's verdict and where
// the row came from: do not open it before you have labelled) and LABEL.txt. Then:
//   npm run eval:judge-agreement -- results/stage6-locomo-judge-validation
// Rows whose answer call failed are left out: they have no answer to grade, and the judge is not asked about them.
const fs = require('fs');
const path = require('path');
const { parseCsv, toCsv, gitCommit, command, option } = require('./meta');
const { createRng } = require('../services/datasets/common');

const RESULTS = path.join(__dirname, '..', 'results');

function main() {
  const args = process.argv.slice(2);
  const prefix = option(args, '--prefix', 'stage6-locomo-ollama-conv-');
  const perSample = Number(option(args, '--per-sample', 5));
  const seed = Number(option(args, '--seed', 11));
  const dirs = fs.readdirSync(RESULTS).filter((d) => d.startsWith(prefix) && fs.existsSync(path.join(RESULTS, d, 'answers.csv'))).sort();
  if (!dirs.length) throw new Error(`no ${prefix}* folders with answers.csv under results/`);
  const rng = createRng(seed);
  const picked = [];
  for (const d of dirs) {
    const rows = parseCsv(fs.readFileSync(path.join(RESULTS, d, 'answers.csv'), 'utf8')).map((r, i) => ({ r, i })).filter(({ r }) => !r.error);
    for (let i = rows.length - 1; i > 0; i -= 1) {
      const j = rng.int(0, i);
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    picked.push(...rows.slice(0, perSample).map((x) => ({ ...x, folder: d })));
  }
  // One shuffle of the whole sheet, so the rows are not grouped by sample and the order gives nothing away
  for (let i = picked.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  const out = path.join(RESULTS, 'stage6-locomo-judge-validation');
  fs.mkdirSync(out, { recursive: true });
  const sheet = picked.map(({ r }, idx) => ({ row_id: idx + 1, question: r.question, gold: r.gold, candidate: r.answer, human_correct: '' }));
  const key = picked.map(({ r, i, folder }, idx) => ({ row_id: idx + 1, folder, raw_row: i, sample: r.sample, qa_index: r.qa_index, system: r.system, judge_correct: r.judge_correct }));
  fs.writeFileSync(path.join(out, 'judge_validation.csv'), toCsv(sheet));
  fs.writeFileSync(path.join(out, 'judge_validation_key.csv'), toCsv(key));
  fs.writeFileSync(path.join(out, 'LABEL.txt'), [
    'Judge validation sheet for the LoCoMo run (dataset: benchmark, LoCoMo). Rows are a seeded random draw, not chosen by hand.',
    `command: ${command('eval:judge-sample', args)}`,
    `commit: ${gitCommit()} (the code that ran)`,
    `date: ${new Date().toISOString()}`,
    `rows: ${sheet.length} (${perSample} from each of ${dirs.length} samples; answers whose call failed are excluded); seed ${seed}`,
    'Fill human_correct with 1 (the candidate is correct) or 0 (wrong), following prompts/judge.v1.md. Do not open judge_validation_key.csv first.',
    '',
  ].join('\n'));
  console.log(`Wrote ${sheet.length} rows to ${path.relative(process.cwd(), out)}/ (label judge_validation.csv, then: npm run eval:judge-agreement -- results/stage6-locomo-judge-validation)`);
}

main();
