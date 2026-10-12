// Checks the LLM judge against YOUR labels:  npm run eval:judge-agreement -- results/<run-id>
// Fill the human_correct column of judge_validation.csv with 1 (correct) or 0 (wrong) first. Rows left empty
// are skipped. Prints and writes judge_agreement.txt: raw agreement and Cohen's kappa (agreement corrected
// for chance, Cohen 1960), with the confusion counts.
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./meta');

function cohenKappa(pairs) {
  const n = pairs.length;
  if (n === 0) return { n: 0, agreement: null, kappa: null };
  const agree = pairs.filter(([h, j]) => h === j).length / n;
  const h1 = pairs.filter(([h]) => h === 1).length / n;
  const j1 = pairs.filter(([, j]) => j === 1).length / n;
  const chance = h1 * j1 + (1 - h1) * (1 - j1);
  return { n, agreement: agree, kappa: chance === 1 ? null : (agree - chance) / (1 - chance) };
}

function main(dir) {
  const labels = parseCsv(fs.readFileSync(path.join(dir, 'judge_validation.csv'), 'utf8'));
  const key = new Map(parseCsv(fs.readFileSync(path.join(dir, 'judge_validation_key.csv'), 'utf8')).map((r) => [r.row_id, r]));
  const pairs = labels.filter((r) => r.human_correct === '0' || r.human_correct === '1').map((r) => [Number(r.human_correct), Number(key.get(r.row_id).judge_correct)]);
  const { n, agreement, kappa } = cohenKappa(pairs);
  const count = (h, j) => pairs.filter(([a, b]) => a === h && b === j).length;
  const text = [
    `judge validation for ${dir}: ${n} of ${labels.length} rows labelled by a human`,
    `agreement: ${agreement === null ? 'n/a' : agreement.toFixed(3)}; Cohen's kappa: ${kappa === null ? 'n/a' : kappa.toFixed(3)}`,
    `human 1 / judge 1: ${count(1, 1)}; human 1 / judge 0: ${count(1, 0)}; human 0 / judge 1: ${count(0, 1)}; human 0 / judge 0: ${count(0, 0)}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'judge_agreement.txt'), text);
  console.log(text);
}

if (require.main === module) {
  if (!process.argv[2]) {
    console.error('usage: npm run eval:judge-agreement -- results/<run-id>');
    process.exit(1);
  }
  main(process.argv[2]);
}

module.exports = { cohenKappa };
