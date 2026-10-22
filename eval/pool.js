// Pools the per-sample LoCoMo runs into one table, with the same bootstrap helpers as the single-run summaries.
//   npm run eval:pool                       pools results/stage6-locomo-ollama-conv-*  ->  results/stage6-locomo-pooled.*
//   npm run eval:pool -- --prefix <name>    another run-folder prefix
//   npm run eval:pool -- --prefix stage6c-lme-pilot- --out-name stage6c-lme-pilot-pooled --dataset-label "LongMemEval (benchmark), pilot"
// It reads only answers.csv (one row per question x system), so every pooled number comes from the same rows the
// per-sample summaries were built from. Failed answers are shown in two ways, never hidden:
//   all     every question; a failed call is scored wrong, exactly as the per-sample summaries do
//   valid   only questions whose answer call succeeded (n is printed, so a shrunken n cannot pass for a full one)
const fs = require('fs');
const path = require('path');
const { parseCsv, toCsv, gitCommit, command, option } = require('./meta');
const { mean, round, pairedBootstrap, bootstrapMean } = require('./stats');
const { SYSTEM_IDS } = require('./systems');

const RESULTS = path.join(__dirname, '..', 'results');
const BASELINE = 'ours';

const num = (x) => (x === '' || x === undefined ? null : Number(x));

// retryDir: a folder of answers.csv rows that ask again questions which failed (eval:retry). A retried row that
// answered replaces the failed row of the same (sample, question, system); a retried row that failed again changes nothing.
function load(prefix, retryDir = null) {
  const dirs = fs.readdirSync(RESULTS).filter((d) => d.startsWith(prefix) && fs.existsSync(path.join(RESULTS, d, 'answers.csv'))).sort();
  const rows = [];
  for (const d of dirs) {
    for (const r of parseCsv(fs.readFileSync(path.join(RESULTS, d, 'answers.csv'), 'utf8'))) {
      rows.push({
        key: `${r.sample}|${r.qa_index}`,
        sample: r.sample,
        type: r.question_type,
        system: r.system,
        f1: num(r.score_f1) || 0,
        judge: num(r.judge_correct) || 0,
        recall: num(r.recall_at_k),
        error: r.error || '',
        abstained: r.insufficient === 'true',
        ms: (num(r.retrieval_ms) || 0) + (num(r.answer_ms) || 0),
      });
    }
  }
  let repaired = 0;
  if (retryDir && fs.existsSync(path.join(retryDir, 'answers.csv'))) {
    for (const r of parseCsv(fs.readFileSync(path.join(retryDir, 'answers.csv'), 'utf8'))) {
      if (r.error) continue;
      const row = rows.find((x) => x.key === `${r.sample}|${r.qa_index}` && x.system === r.system && x.error);
      if (!row) continue;
      Object.assign(row, { f1: num(r.score_f1) || 0, judge: num(r.judge_correct) || 0, recall: num(r.recall_at_k), error: '', abstained: r.insufficient === 'true', ms: (num(r.retrieval_ms) || 0) + (num(r.answer_ms) || 0) });
      repaired += 1;
    }
  }
  return { dirs, rows, repaired };
}

const by = (rows, key) => rows.reduce((m, r) => m.set(key(r), [...(m.get(key(r)) || []), r]), new Map());

function line(system, rows, extra = {}) {
  const f1 = bootstrapMean(rows.map((r) => r.f1));
  const j = bootstrapMean(rows.map((r) => r.judge));
  const rec = rows.map((r) => r.recall).filter((x) => x !== null);
  return {
    system,
    ...extra,
    n: rows.length,
    errors: rows.filter((r) => r.error).length,
    f1: round(f1.mean, 4), f1_low: round(f1.low, 4), f1_high: round(f1.high, 4),
    judge: round(j.mean, 4), judge_low: round(j.low, 4), judge_high: round(j.high, 4),
    recall_at_k: rec.length ? round(mean(rec), 4) : null,
    abstained: rows.filter((r) => r.abstained).length,
  };
}

function main() {
  const args = process.argv.slice(2);
  const prefix = option(args, '--prefix', 'stage6-locomo-ollama-conv-');
  const outName = option(args, '--out-name', 'stage6-locomo-pooled');
  const datasetLabel = option(args, '--dataset-label', 'LoCoMo (benchmark, CC BY-NC 4.0)');
  const retryDir = option(args, '--retry-dir') ? path.resolve(option(args, '--retry-dir')) : null;
  const { dirs, rows, repaired } = load(prefix, retryDir);
  if (!rows.length) throw new Error(`no ${prefix}* folders with answers.csv under results/`);
  const systems = SYSTEM_IDS.filter((s) => rows.some((r) => r.system === s));
  const samples = [...new Set(rows.map((r) => r.sample))].sort();
  const questions = new Set(rows.map((r) => r.key)).size;

  const out = { all: [], valid: [], byType: [], perSample: [], paired: [] };
  for (const s of systems) {
    const mine = rows.filter((r) => r.system === s);
    out.all.push(line(s, mine));
    out.valid.push(line(s, mine.filter((r) => !r.error)));
    for (const [type, group] of by(mine, (r) => r.type)) out.byType.push(line(s, group, { type }));
    for (const [sample, group] of by(mine, (r) => r.sample)) out.perSample.push(line(s, group, { sample }));
  }
  out.byType.sort((a, b) => a.type.localeCompare(b.type) || systems.indexOf(a.system) - systems.indexOf(b.system));

  // Paired comparison with the baseline on questions where BOTH answered (a failed call has no answer to compare)
  const ok = new Map(systems.map((s) => [s, new Map(rows.filter((r) => r.system === s && !r.error).map((r) => [r.key, r]))]));
  for (const s of systems.filter((x) => x !== BASELINE)) {
    const sharedAll = [...ok.get(BASELINE).keys()].filter((k) => ok.get(s).has(k));
    const scopes = [['all types', sharedAll], ...[...new Set(rows.map((r) => r.type))].sort().map((t) => [t, sharedAll.filter((k) => ok.get(BASELINE).get(k).type === t)])];
    for (const [scope, shared] of scopes) for (const [metric, field] of [['judge accuracy', 'judge'], ['token F1', 'f1']]) {
      const a = shared.map((k) => ok.get(BASELINE).get(k)[field]);
      const b = shared.map((k) => ok.get(s).get(k)[field]);
      const ci = pairedBootstrap(a, b);
      // Win counts use the same shared questions, per sample, so a sample where the other system failed is not counted
      const bySample = by(shared, (k) => k.split('|')[0]);
      let wins = 0;
      let losses = 0;
      for (const keys of bySample.values()) {
        const diff = mean(keys.map((k) => ok.get(BASELINE).get(k)[field] - ok.get(s).get(k)[field]));
        if (diff > 0) wins += 1;
        else if (diff < 0) losses += 1;
      }
      out.paired.push({
        comparison: `${BASELINE} minus ${s}`, scope, metric, shared_questions: ci.n,
        diff: round(ci.diff, 4), ci_low: round(ci.low, 4), ci_high: round(ci.high, 4),
        interval_excludes_zero: ci.low > 0 || ci.high < 0 ? 'yes' : 'no',
        samples_where_ours_higher: wins, samples_where_ours_lower: losses, samples_compared: bySample.size,
      });
    }
  }

  const stamp = {
    command: command('eval:pool', args),
    commit: `${gitCommit()} (the code that ran; the results are committed in a later commit)`,
    date: new Date().toISOString(),
    ...(retryDir ? { repaired: `${repaired} failed answers replaced by answered retries from ${path.relative(process.cwd(), retryDir)}` } : {}),
    dataset: `${datasetLabel}: ${samples.length} samples, ${questions} questions, ${systems.length} systems; run folders ${dirs.length}`,
  };
  const pct = (x) => (x === null ? 'n/a' : x.toFixed(3));
  const table = (list) => list.map((r) => `${r.system.padEnd(20)} n=${String(r.n).padStart(4)} failed=${String(r.errors).padStart(4)}  F1 ${pct(r.f1)} [${pct(r.f1_low)}, ${pct(r.f1_high)}]  judge ${pct(r.judge)} [${pct(r.judge_low)}, ${pct(r.judge_high)}]  recall@k ${pct(r.recall_at_k)}`).join('\n');
  const text = [
    `Pooled results across all finished samples: ${datasetLabel}`,
    ...Object.entries(stamp).map(([k, v]) => `${k}: ${v}`),
    'models: answer/extract/reconcile qwen2.5-coder:14b, judge deepseek-r1:14b, embeddings nomic-embed-text (from each run\'s meta.txt)',
    'intervals: 95% bootstrap over questions (2000 resamples, seeded). Questions from one conversation are not independent,',
    'so the true uncertainty is wider than these intervals; the per-sample table and win counts show the spread.',
    'judge scores come from an LLM judge whose agreement with a human has NOT been measured yet (see judge_validation.csv).',
    '',
    'ALL questions (a failed call is scored wrong, as in the per-sample summaries)',
    table(out.all),
    '',
    'VALID answers only (failed calls left out; compare n before comparing means)',
    table(out.valid),
    '',
    `PAIRED: ${BASELINE} minus another system, on questions both answered (95% paired bootstrap interval of the difference)`,
    ...out.paired.map((r) => `${r.comparison.padEnd(34)} ${r.scope.padEnd(11)} ${r.metric.padEnd(15)} n=${String(r.shared_questions).padStart(4)}  diff ${r.diff >= 0 ? '+' : ''}${pct(r.diff)} [${pct(r.ci_low)}, ${pct(r.ci_high)}]  excludes 0: ${r.interval_excludes_zero}  ours higher in ${r.samples_where_ours_higher} / lower in ${r.samples_where_ours_lower} of ${r.samples_compared} samples`),
    '',
    'BY QUESTION TYPE (all questions)',
    ...out.byType.map((r) => `${r.type.padEnd(14)} ${r.system.padEnd(20)} n=${String(r.n).padStart(4)} failed=${String(r.errors).padStart(3)}  F1 ${pct(r.f1)} [${pct(r.f1_low)}, ${pct(r.f1_high)}]  judge ${pct(r.judge)} [${pct(r.judge_low)}, ${pct(r.judge_high)}]  recall@k ${pct(r.recall_at_k)}`),
    '',
  ].join('\n');

  const base = path.join(RESULTS, outName);
  fs.writeFileSync(`${base}.txt`, text);
  fs.writeFileSync(`${base}-all.csv`, toCsv(out.all));
  fs.writeFileSync(`${base}-valid.csv`, toCsv(out.valid));
  fs.writeFileSync(`${base}-by-type.csv`, toCsv(out.byType));
  fs.writeFileSync(`${base}-per-sample.csv`, toCsv(out.perSample));
  fs.writeFileSync(`${base}-paired.csv`, toCsv(out.paired));
  console.log(text.split('\n').slice(0, 30).join('\n'));
  console.log(`Wrote ${path.relative(process.cwd(), base)}.txt and 5 CSV files`);
}

if (require.main === module) main();

module.exports = { load, line };
