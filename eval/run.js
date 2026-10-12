// Stage 6 evaluation run on LoCoMo (dataset label: benchmark).
//   npm run eval -- --questions 10                       pipeline check: 1 sample, 10 questions, mock model
//   npm run eval -- --samples all --questions 0 --paid   the full run with the real model (costs money)
// Options: --samples conv-26,conv-30 | all (default: the first sample)   --questions N per sample (0 = all)
//          --k 10 (context items for RAG and memory systems)   --systems full_context,ours,...   --seed 1
//          --run-id <name>   --out results   --judge-sample 50
// Safety: the model comes from LLM_PROVIDER (services/llm). Anything but the mock, or a paid embedding
// provider, needs --paid, so no run can spend money by accident.
// Writes results/<run-id>/: LABEL.txt, meta.txt, config.json, raw.jsonl, answers.csv, summary_by_system.csv,
// summary_by_type.csv, bootstrap_vs_ours.csv, build.csv, judge_validation.csv (+ _key.csv) and the charts.
// Uses its own database (MONGO_URI_EVAL, the name must contain "eval"), which it DROPS before each sample.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { llmConfig } = require('../services/llm/config');
const { embeddingConfig } = require('../services/embeddings/config');
const { evaluateSample } = require('./harness');
const { SYSTEM_IDS } = require('./systems');
const report = require('./report');
const { gitCommit, machine, command, option, assertDisposable, toCsv } = require('./meta');

const MONGO_URI = process.env.MONGO_URI_EVAL || 'mongodb://127.0.0.1:27017/aimemory_eval';
const DATA = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'locomo', 'locomo10.json');

async function main() {
  const commit = gitCommit();
  const args = process.argv.slice(2);
  const llm = llmConfig();
  const emb = embeddingConfig();
  const paid = args.includes('--paid');
  if ((llm.provider !== 'mock' || emb.provider === 'voyage') && !paid) {
    throw new Error(`LLM_PROVIDER=${llm.provider}, EMBEDDING_PROVIDER=${emb.provider}: this run would call a paid API. Add --paid if you mean it.`);
  }
  const mock = llm.provider === 'mock';
  const questions = Number(option(args, '--questions', 10));
  const k = Number(option(args, '--k', 10));
  const seed = Number(option(args, '--seed', 1));
  const systems = String(option(args, '--systems', SYSTEM_IDS.join(','))).split(',');
  const judgeSample = Number(option(args, '--judge-sample', 50));
  if (!fs.existsSync(DATA)) throw new Error(`${DATA} not found: run "npm run data:download" first`);
  const all = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const wanted = String(option(args, '--samples', all[0].sample_id));
  const samples = wanted === 'all' ? all : wanted.split(',').map((id) => all.find((s) => s.sample_id === id) || (() => { throw new Error(`No LoCoMo sample "${id}"`); })());
  const date = new Date().toISOString();
  const runId = option(args, '--run-id', `stage6-${mock ? 'pipeline-check-mock' : 'locomo'}-${date.slice(0, 10)}`);
  const dir = path.join(option(args, '--out', 'results'), runId);
  const label = mock
    ? 'PIPELINE CHECK (mock model), NOT A RESULT. The mock answers and judges by word overlap; these numbers only show that the harness runs end to end.'
    : `LoCoMo QA evaluation with ${llm.models.answer} (answers) and ${llm.models.judge} (judge). Judge not yet validated against human labels.`;

  assertDisposable(MONGO_URI, 'eval');
  await mongoose.connect(MONGO_URI);
  const rows = [];
  const builds = [];
  const started = Date.now();
  for (const sample of samples) {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.syncIndexes();
    const out = await evaluateSample(sample, { questions, k, systems, seed, log: (line) => console.log(line) });
    rows.push(...out.rows);
    builds.push(...out.builds);
  }
  await mongoose.connection.dropDatabase();
  const meta = (await mongoose.connection.db.admin().serverInfo()).version;
  await mongoose.disconnect();

  fs.mkdirSync(dir, { recursive: true });
  const write = (file, text) => fs.writeFileSync(path.join(dir, file), text);
  const config = { runId, questionsPerSample: questions, samples: samples.map((s) => s.sample_id), k, seed, systems, llm: { provider: llm.provider, models: llm.models, effort: llm.effort }, embeddings: { provider: emb.provider }, prompts: { answer: 'eval-answer.v1', judge: 'judge.v1', extract: 'extract.v1', reconcile: 'reconcile.v1' } };
  write('LABEL.txt', `${label}\n`);
  write('config.json', `${JSON.stringify(config, null, 2)}\n`);
  write(
    'meta.txt',
    [
      `label: ${label}`,
      `command: ${command('eval', args)}`,
      `git commit: ${commit} (the code that ran; results are committed in a later commit)`,
      `date: ${date}`,
      `dataset: BENCHMARK - LoCoMo (${DATA.replace(process.cwd() + path.sep, '')}, samples ${config.samples.join(', ')}; ${questions || 'all'} questions per sample)`,
      `llm provider: ${llm.provider}; embeddings: ${emb.provider}; k = ${k}; seed = ${seed}`,
      `wall-clock: ${Math.round((Date.now() - started) / 1000)} s; machine: ${machine()}; node ${process.version}; mongodb ${meta}`,
      '',
    ].join('\n')
  );
  write('raw.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  write('answers.csv', toCsv(rows));
  write('summary_by_system.csv', toCsv(report.bySystem(rows, systems)));
  write('summary_by_type.csv', toCsv(report.byType(rows, systems)));
  const versus = report.versusOurs(rows);
  if (versus.length) write('bootstrap_vs_ours.csv', toCsv(versus));
  const buildHeader = ['sample', 'store', 'messages_mined', 'decisions', 'memory_versions', 'memory_current', 'memory_bytes', 'extract_calls', 'reconcile_calls', 'build_input_tokens', 'build_output_tokens', 'build_cost_usd', 'build_seconds'];
  write('build.csv', toCsv(builds, buildHeader));
  const jv = report.judgeValidation(rows, judgeSample);
  write('judge_validation.csv', toCsv(jv.toLabel));
  write('judge_validation_key.csv', toCsv(jv.key));
  require('./charts').evalCharts(dir);

  console.log(`\n${label}`);
  for (const r of report.bySystem(rows, systems)) console.log(`  ${r.system}: n=${r.n} F1=${r.score_f1_mean} judge=${r.judge_accuracy} recall@k=${r.recall_at_k_mean}`);
  console.log(`Wrote ${dir}/`);
}

main().catch(async (err) => {
  console.error(err.stack || err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
