// Why do the memory systems look alike on LongMemEval? Counts from the committed per-question run folders.
//   npm run eval:lme-diagnostics     writes results/stage6c-lme-pilot-diagnostics.txt
// Reads answers.csv and build.csv of every results/stage6c-lme-pilot-* folder; no model, no database.
const fs = require('fs');
const path = require('path');
const { parseCsv, gitCommit, command } = require('./meta');

const RESULTS = path.join(__dirname, '..', 'results');
const mean = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);

function main() {
  const dirs = fs.readdirSync(RESULTS).filter((d) => d.startsWith('stage6c-lme-pilot-') && fs.existsSync(path.join(RESULTS, d, 'answers.csv'))).sort();
  const abstained = {};
  const asked = {};
  const identical = { equal: 0, total: 0 };
  const build = { mined: [], bitemporal: [], current: [], overwrite: [], superseded: [] };
  for (const d of dirs) {
    const rows = parseCsv(fs.readFileSync(path.join(RESULTS, d, 'answers.csv'), 'utf8'));
    const bySystem = {};
    for (const r of rows) {
      abstained[r.system] = (abstained[r.system] || 0) + (r.insufficient === 'true' ? 1 : 0);
      asked[r.system] = (asked[r.system] || 0) + 1;
      bySystem[r.system] = r;
    }
    identical.total += 1;
    if (bySystem.ours.answer === bySystem.overwrite_memory.answer) identical.equal += 1;
    for (const b of parseCsv(fs.readFileSync(path.join(RESULTS, d, 'build.csv'), 'utf8'))) {
      if (b.store === 'bitemporal') {
        build.mined.push(Number(b.messages_mined));
        build.bitemporal.push(Number(b.memory_versions));
        build.current.push(Number(b.memory_current));
        build.superseded.push(Number(b.memory_versions) - Number(b.memory_current));
      }
      if (b.store === 'overwrite') build.overwrite.push(Number(b.memory_versions));
    }
  }
  const lines = [
    'LongMemEval pilot diagnostics (dataset: benchmark, LongMemEval; knowledge-update and temporal-reasoning)',
    `command: ${command('eval:lme-diagnostics', [])}`,
    `commit: ${gitCommit()} (the code that ran; the results are committed in a later commit)`,
    `date: ${new Date().toISOString()}`,
    `questions: ${dirs.length}`,
    '',
    'answers that say the information is not available (abstained), per system:',
    ...Object.keys(asked).map((s) => `  ${s}: ${abstained[s]} of ${asked[s]}`),
    '',
    `identical answer text, ours and overwrite_memory: ${identical.equal} of ${identical.total} questions`,
    '',
    'memory store per question (means):',
    `  user messages mined: ${mean(build.mined)}`,
    `  bitemporal memory versions: ${mean(build.bitemporal)} (current ${mean(build.current)}, superseded ${mean(build.superseded)})`,
    `  overwrite memories: ${mean(build.overwrite)}`,
    '',
  ];
  fs.writeFileSync(path.join(RESULTS, 'stage6c-lme-pilot-diagnostics.txt'), lines.join('\n'));
  console.log(lines.join('\n'));
}

main();
