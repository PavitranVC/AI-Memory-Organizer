// Stage 6 evaluation run on LoCoMo (dataset label: benchmark).
//   npm run eval -- --questions 10                       pipeline check: 1 sample, 10 questions, mock model
//   npm run eval -- --provider ollama --questions 10     pilot on the free local models (Stage 3b)
//   npm run eval -- --samples all --questions 0 --paid   the full run with the real model (costs money)
// Options: --samples conv-26,conv-30 | all (default: the first sample)   --questions N per sample (0 = all)
//          --k 10 (context items for RAG and memory systems)   --systems full_context,ours,...   --seed 1
//          --run-id <name>   --out results   --judge-sample 50
//          --provider mock|anthropic|ollama   --model <name> (extract, reconcile, answer)   --judge-model <name>
//          --embeddings lexical|ollama|voyage (each one overrides the matching variable in .env)
// Safety: the model comes from LLM_PROVIDER (services/llm). Anthropic or a paid embedding provider needs
// --paid, so no run can spend money by accident. Ollama is free (local) and needs no flag.
// Writes results/<run-id>/: LABEL.txt, meta.txt, config.json, raw.jsonl, answers.csv, summary_by_system.csv,
// summary_by_type.csv, bootstrap_vs_ours.csv, build.csv, timing.json, judge_validation.csv (+ _key.csv) and
// the charts.
// Uses its own database (MONGO_URI_EVAL, the name must contain "eval"), which it DROPS before each sample.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { llmConfig } = require('../services/llm/config');
const { embeddingConfig } = require('../services/embeddings/config');
const { readyEmbedder } = require('../services/embeddings');
const { evaluateSample } = require('./harness');
const { SYSTEM_IDS } = require('./systems');
const report = require('./report');
const { gitCommit, machine, command, option, assertDisposable, toCsv } = require('./meta');

const MONGO_URI = process.env.MONGO_URI_EVAL || 'mongodb://127.0.0.1:27017/aimemory_eval';
const DATA = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'locomo', 'locomo10.json');

// Command-line choices are written into process.env, because services/llm reads its settings on every call
function applyOptions(args) {
  const provider = option(args, '--provider');
  if (provider) process.env.LLM_PROVIDER = provider;
  const model = option(args, '--model');
  if (model) {
    if ((process.env.LLM_PROVIDER || 'mock').toLowerCase() === 'ollama') process.env.OLLAMA_MODEL = model;
    else for (const name of ['EXTRACTION_MODEL', 'RECONCILE_MODEL', 'ANSWER_MODEL']) process.env[name] = model;
  }
  const judge = option(args, '--judge-model');
  if (judge) process.env.JUDGE_MODEL = judge;
  const embeddings = option(args, '--embeddings');
  if (embeddings) process.env.EMBEDDING_PROVIDER = embeddings;
}

// The Ollama server's version, for meta.txt (a different version can give different answers)
async function ollamaVersion(url) {
  try {
    const response = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(3000) });
    return (await response.json()).version || 'unknown';
  } catch (err) {
    return 'not reachable';
  }
}

async function main() {
  const commit = gitCommit();
  const args = process.argv.slice(2);
  applyOptions(args);
  const llm = llmConfig();
  const emb = embeddingConfig();
  const paid = args.includes('--paid');
  if ((llm.provider === 'anthropic' || emb.provider === 'voyage') && !paid) {
    throw new Error(`LLM_PROVIDER=${llm.provider}, EMBEDDING_PROVIDER=${emb.provider}: this run would call a paid API. Add --paid if you mean it.`);
  }
  const mock = llm.provider === 'mock';
  const embedder = await readyEmbedder();
  const ollama = llm.provider === 'ollama' || emb.provider === 'ollama' ? await ollamaVersion((llm.ollama || emb.ollama).url.replace(/\/+$/, '')) : null;
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
  const runId = option(args, '--run-id', `stage6-${mock ? 'pipeline-check-mock' : `locomo-${llm.provider}`}-${date.slice(0, 10)}`);
  const dir = path.join(option(args, '--out', 'results'), runId);
  const label = mock
    ? 'PIPELINE CHECK (mock model), NOT A RESULT. The mock answers and judges by word overlap; these numbers only show that the harness runs end to end.'
    : `LoCoMo QA evaluation with ${llm.models.answer} (answers) and ${llm.models.judge} (judge)${llm.provider === 'ollama' ? ', local models through Ollama' : ''}. Judge not yet validated against human labels.`;

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
  const config = { runId, questionsPerSample: questions, samples: samples.map((s) => s.sample_id), k, seed, systems, llm: { provider: llm.provider, models: llm.models, effort: llm.provider === 'anthropic' ? llm.effort : null, ollama: llm.ollama || null, ollamaVersion: ollama }, embeddings: { provider: emb.provider, model: embedder.id }, prompts: { answer: 'eval-answer.v1', judge: 'judge.v1', extract: 'extract.v1', reconcile: 'reconcile.v1' } };
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
      `llm provider: ${llm.provider}; embeddings: ${embedder.id}; k = ${k}; seed = ${seed}`,
      `models: extract ${llm.models.extract}, reconcile ${llm.models.reconcile}, answer ${llm.models.answer}, judge ${llm.models.judge}${ollama ? `; ollama ${ollama}` : ''}`,
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
  const timing = report.timing(rows, builds);
  write('timing.json', `${JSON.stringify({ runId, models: llm.models, provider: llm.provider, ...timing }, null, 2)}\n`);
  const jv = report.judgeValidation(rows, judgeSample);
  write('judge_validation.csv', toCsv(jv.toLabel));
  write('judge_validation_key.csv', toCsv(jv.key));
  require('./charts').evalCharts(dir);

  console.log(`\n${label}`);
  for (const r of report.bySystem(rows, systems)) console.log(`  ${r.system}: n=${r.n} F1=${r.score_f1_mean} judge=${r.judge_accuracy} recall@k=${r.recall_at_k_mean}`);
  console.log(`  time per item (s): judge ${timing.seconds_per_judge}; build per message ${JSON.stringify(timing.seconds_per_message)}`);
  console.log(`Wrote ${dir}/`);
}

main().catch(async (err) => {
  console.error(err.stack || err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
