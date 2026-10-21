// Stage 6 evaluation run on LoCoMo or LongMemEval (dataset label: benchmark).
//   npm run eval -- --questions 10                       pipeline check: 1 sample, 10 questions, mock model
//   npm run eval -- --provider ollama --questions 10     pilot on the free local models (Stage 3b)
//   npm run eval -- --samples all --questions 0 --paid   the full run with the real model (costs money)
// Options: --samples conv-26,conv-30 | all (default: the first sample)   --questions N per sample (0 = all)
//          --k 10 (context items for RAG and memory systems)   --systems full_context,ours,...   --seed 1
//          --run-id <name>   --out results   --judge-sample 50   --resume-check   --restart
//          --provider mock|anthropic|ollama   --model <name> (extract, reconcile, answer)   --judge-model <name>
//          --embeddings lexical|ollama|voyage (each one overrides the matching variable in .env)
// Safety: the model comes from LLM_PROVIDER (services/llm). Anthropic or a paid embedding provider needs
// --paid, so no run can spend money by accident. Ollama is free (local) and needs no flag.
// Writes results/<run-id>/: LABEL.txt, meta.txt, config.json, raw.jsonl, answers.csv, summary_by_system.csv,
// summary_by_type.csv, bootstrap_vs_ours.csv, build.csv, timing.json, judge_validation.csv (+ _key.csv) and
// the charts.
// Uses its own database (MONGO_URI_EVAL, the name must contain "eval"), which it DROPS when a sample starts new.
// Stage 6c: --dataset longmemeval runs the same systems on LongMemEval questions (one question = one sample, with its
// own chat history): --file longmemeval_s_cleaned.json --types knowledge-update,temporal-reasoning --per-type 12
// --ids <question ids>. full_context is left out by default there (a history is far longer than the window);
// --systems can put it back. npm run eval:preflight shows which samples fit the window before anything runs.
// Stage 6b: every finished answer is written at once to results/<run-id>/checkpoint.jsonl. Running the SAME
// command again continues an interrupted run (same results files as an uninterrupted run); --resume-check shows
// what is done without running anything; --restart sets the old checkpoint aside and starts from nothing.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { llmConfig } = require('../services/llm/config');
const { ACTIVE } = require('../services/llm/prompts'); // the prompt versions this run used, from one place
const { embeddingConfig } = require('../services/embeddings/config');
const { readyEmbedder } = require('../services/embeddings');
const { evaluateSample, pickQuestions } = require('./harness');
const { fullContextFit } = require('./preflight');
const { selectQuestions } = require('../services/datasets/longmemeval');
const { Ledger } = require('./checkpoint');
const { SYSTEM_IDS } = require('./systems');
const report = require('./report');
const { gitCommit, machine, command, option, assertDisposable, toCsv } = require('./meta');

const MONGO_URI = process.env.MONGO_URI_EVAL || 'mongodb://127.0.0.1:27017/aimemory_eval';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA = path.join(DATA_DIR, 'locomo', 'locomo10.json');

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

// --resume-check: what the checkpoint of this run holds, without running anything
function printResumeCheck(dir, samples, { questions, seed, systems }) {
  const state = Ledger.inspect(dir);
  if (!state.header) {
    console.log(`${dir}: no checkpoint yet (a run with this --run-id starts from the beginning)`);
    return;
  }
  const same = state.header.fingerprint;
  console.log(`${dir}/checkpoint.jsonl: started ${state.header.at}, continued ${state.resumes.length} time(s), ${state.complete ? 'COMPLETE' : 'not complete'}${state.badLines ? `, ${state.badLines} damaged line(s) skipped` : ''}`);
  let done = 0;
  let total = 0;
  for (const sample of samples) {
    const n = pickQuestions(sample.qa, questions, seed).length;
    const entry = state.samples.get(sample.sample_id);
    const perSystem = systems.map((id) => {
      const have = entry ? [...entry.rows.keys()].filter((key) => key.startsWith(`${id}|`)).length : 0;
      done += have;
      total += n;
      return `${id} ${have}/${n}`;
    });
    const stores = entry ? [...entry.builds.keys()].filter((b) => b !== 'raw messages').join(', ') || 'none' : 'none';
    console.log(`  ${sample.sample_id}${entry && entry.done ? ' (finished)' : ''}: ${perSystem.join(', ')}; builds recorded: ${stores}`);
  }
  console.log(`  ${done} of ${total} answers are in the checkpoint (${total ? Math.round((100 * done) / total) : 0}%). Same command again continues from here.`);
  if (same && same.questionsPerSample !== questions) console.log(`  WARNING: the checkpoint was made with --questions ${same.questionsPerSample}, not ${questions}; a run would refuse to continue it`);
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
  let questions = Number(option(args, '--questions', 10));
  const k = Number(option(args, '--k', 10));
  const seed = Number(option(args, '--seed', 1));
  const dataset = option(args, '--dataset', 'locomo');
  if (!['locomo', 'longmemeval'].includes(dataset)) throw new Error(`--dataset must be locomo or longmemeval, not "${dataset}"`);
  const lme = dataset === 'longmemeval';
  if (lme) questions = 1; // one question per LongMemEval sample
  // A LongMemEval history is far longer than the context window, so the full-context baseline would only produce errors
  const systems = String(option(args, '--systems', (lme ? SYSTEM_IDS.filter((id) => id !== 'full_context') : SYSTEM_IDS).join(','))).split(',');
  const judgeSample = Number(option(args, '--judge-sample', 50));
  let samples;
  let dataFile = DATA;
  if (lme) {
    dataFile = path.join(DATA_DIR, 'longmemeval', option(args, '--file', 'longmemeval_s_cleaned.json'));
    if (!fs.existsSync(dataFile)) throw new Error(`${dataFile} not found: run "npm run data:download -- longmemeval" first`);
    const list = (name) => (option(args, name) ? String(option(args, name)).split(',') : undefined);
    const chosen = selectQuestions(JSON.parse(fs.readFileSync(dataFile, 'utf8')), { types: list('--types'), ids: list('--ids'), perType: option(args, '--per-type') ? Number(option(args, '--per-type')) : undefined, seed });
    if (!chosen.length) throw new Error('No LongMemEval question matches --types / --per-type / --ids');
    // One question per sample; qa only carries what the resume check needs (how many questions)
    samples = chosen.map((item) => ({ sample_id: item.question_id, qa: [{ category: 0 }], item }));
  } else {
    if (!fs.existsSync(DATA)) throw new Error(`${DATA} not found: run "npm run data:download" first`);
    const all = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const wanted = String(option(args, '--samples', all[0].sample_id));
    samples = wanted === 'all' ? all : wanted.split(',').map((id) => all.find((s) => s.sample_id === id) || (() => { throw new Error(`No LoCoMo sample "${id}"`); })());
  }
  if (systems.includes('full_context') && (llm.ollama || {}).numCtxLarge) {
    const { prepareLocomo, prepareLongMemEval } = require('./harness');
    const unfit = samples.filter((x) => !fullContextFit((lme ? prepareLongMemEval(x) : prepareLocomo(x, { questions: 1, seed: 1 })).messages, llm.ollama).fits).length;
    if (unfit) console.warn(`WARNING: ${unfit} of ${samples.length} sample(s) are longer than OLLAMA_NUM_CTX_LARGE=${llm.ollama.numCtxLarge}; full_context will fail on them (npm run eval:preflight lists them).`);
  }
  const date = new Date().toISOString();
  const runId = option(args, '--run-id', `stage6-${mock ? 'pipeline-check-mock' : `${dataset}-${llm.provider}`}-${date.slice(0, 10)}`);
  const dir = path.join(option(args, '--out', 'results'), runId);
  const label = mock
    ? 'PIPELINE CHECK (mock model), NOT A RESULT. The mock answers and judges by word overlap; these numbers only show that the harness runs end to end.'
    : `${lme ? 'LongMemEval' : 'LoCoMo'} QA evaluation with ${llm.models.answer} (answers) and ${llm.models.judge} (judge)${llm.provider === 'ollama' ? ', local models through Ollama' : ''}. Judge not yet validated against human labels.`;

  // What makes two runs the same experiment. A checkpoint is only continued when all of this matches.
  const fingerprint = {
    ...(lme ? { dataset } : {}), // LoCoMo fingerprints stay as they were, so earlier checkpoints still continue
    samples: samples.map((x) => x.sample_id),
    questionsPerSample: lme ? 1 : questions,
    k,
    seed,
    systems,
    provider: llm.provider,
    models: llm.models,
    ollama: llm.ollama ? { numCtx: llm.ollama.numCtx, numCtxLarge: llm.ollama.numCtxLarge } : null,
    embeddings: { provider: emb.provider, model: embedder.id },
    prompts: { answer: ACTIVE.eval_answer, judge: ACTIVE.judge, extract: ACTIVE.extract, reconcile: ACTIVE.reconcile },
  };

  if (args.includes('--resume-check')) {
    printResumeCheck(dir, samples, { questions, seed, systems });
    return;
  }

  assertDisposable(MONGO_URI, 'eval');
  await mongoose.connect(MONGO_URI);
  const ledger = Ledger.open(dir, fingerprint, { restart: args.includes('--restart'), commit });
  if (ledger.resumed) console.log(`Continuing ${dir}/checkpoint.jsonl (${ledger.state.samples.size} sample(s) in the checkpoint, started ${ledger.history().startedAt})`);
  // The disposable database is emptied only when a sample has to start from nothing
  const resetDb = async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.syncIndexes();
  };
  const rows = [];
  const builds = [];
  const started = Date.now();
  for (const sample of samples) {
    const out = await evaluateSample(sample, { questions, k, systems, seed, log: (line) => console.log(line), ledger, resetDb, dataset });
    rows.push(...out.rows);
    builds.push(...out.builds);
  }
  await mongoose.connection.dropDatabase();
  const meta = (await mongoose.connection.db.admin().serverInfo()).version;
  await mongoose.disconnect();

  fs.mkdirSync(dir, { recursive: true });
  const write = (file, text) => fs.writeFileSync(path.join(dir, file), text);
  const config = { runId, questionsPerSample: questions, samples: samples.map((s) => s.sample_id), k, seed, systems, llm: { provider: llm.provider, models: llm.models, effort: llm.provider === 'anthropic' ? llm.effort : null, ollama: llm.ollama || null, ollamaVersion: ollama }, embeddings: { provider: emb.provider, model: embedder.id }, prompts: { answer: ACTIVE.eval_answer, judge: ACTIVE.judge, extract: ACTIVE.extract, reconcile: ACTIVE.reconcile } };
  write('LABEL.txt', `${label}\n`);
  write('config.json', `${JSON.stringify(config, null, 2)}\n`);
  write(
    'meta.txt',
    [
      `label: ${label}`,
      `command: ${command('eval', args)}`,
      `git commit: ${commit} (the code that ran; results are committed in a later commit)`,
      `date: ${date}`,
      `dataset: BENCHMARK - ${lme ? 'LongMemEval' : 'LoCoMo'} (${dataFile.replace(process.cwd() + path.sep, '')}, ${lme ? `${config.samples.length} questions: ${config.samples.join(', ')}` : `samples ${config.samples.join(', ')}; ${questions || 'all'} questions per sample`})`,
      `llm provider: ${llm.provider}; embeddings: ${embedder.id}; k = ${k}; seed = ${seed}`,
      `models: extract ${llm.models.extract}, reconcile ${llm.models.reconcile}, answer ${llm.models.answer}, judge ${llm.models.judge}${ollama ? `; ollama ${ollama}` : ''}`,
      `checkpoint: ${path.join(dir, 'checkpoint.jsonl')}; started again after an interruption ${ledger.history().resumes.length} time(s)${ledger.history().resumes.map((r) => `, at ${r.at} (${r.commit})`).join('')}`,
      `wall-clock of the last process: ${Math.round((Date.now() - started) / 1000)} s; machine: ${machine()}; node ${process.version}; mongodb ${meta}`,
      '',
    ].join('\n')
  );
  write('raw.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  write('answers.csv', toCsv(rows));
  write('summary_by_system.csv', toCsv(report.bySystem(rows, systems)));
  write('summary_by_type.csv', toCsv(report.byType(rows, systems)));
  const versus = report.versusOurs(rows);
  if (versus.length) write('bootstrap_vs_ours.csv', toCsv(versus));
  const buildHeader = ['sample', 'store', 'messages_mined', 'failed_messages', 'decisions', 'memory_versions', 'memory_current', 'memory_bytes', 'extract_calls', 'reconcile_calls', 'build_input_tokens', 'build_output_tokens', 'build_cost_usd', 'build_seconds'];
  write('build.csv', toCsv(builds, buildHeader));
  const timing = report.timing(rows, builds);
  write('timing.json', `${JSON.stringify({ runId, models: llm.models, provider: llm.provider, ...timing }, null, 2)}\n`);
  const jv = report.judgeValidation(rows, judgeSample);
  write('judge_validation.csv', toCsv(jv.toLabel));
  write('judge_validation_key.csv', toCsv(jv.key));
  require('./charts').evalCharts(dir);
  ledger.complete();

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
