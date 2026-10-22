// Asks AGAIN the full-context questions that failed with a TIMEOUT in the finished LoCoMo runs, and records the new
// answers beside the old ones (the original run folders are never changed).
//   npm run eval:retry -- --provider ollama                       the timeouts of every results/stage6-locomo-ollama-conv-*
//   npm run eval:retry -- --provider ollama --samples conv-26     one sample
// Why only timeouts: a failure "the prompt does not fit in OLLAMA_NUM_CTX_LARGE" is real. The conversation has
// more tokens than the model's native 32,768-token window (measured: 33,000 to 40,000 tokens for seven of the ten
// samples), and asking again cannot change that. A timeout can: the model was called but did not answer within the
// limit, and the retry gives it more time (--timeout-ms, default 600000).
// Needs MongoDB only because every model call is logged to the llmcalls collection of the disposable evaluation
// database (MONGO_URI_EVAL, its name must contain "eval"); the full-context prompt itself is just the conversation. Writes results/stage6e-locomo-retry-<system>/
// retried.jsonl (one line per finished question: the run can be stopped and started again), answers.csv and meta.txt.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { llmConfig } = require('../services/llm/config');
const { parseCsv, toCsv, gitCommit, command, option, assertDisposable } = require('./meta');
const mongoose = require('mongoose');
const { prepareLocomo, answerAndScore } = require('./harness');
const S = require('./systems');

const DATA = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'locomo', 'locomo10.json');
const TIMEOUT = /did not answer within/;
const MONGO_URI = process.env.MONGO_URI_EVAL || 'mongodb://127.0.0.1:27017/aimemory_eval';

async function main() {
  const args = process.argv.slice(2);
  const RESULTS = path.resolve(option(args, '--results-dir', path.join(__dirname, '..', 'results')));
  const provider = option(args, '--provider');
  if (provider) process.env.LLM_PROVIDER = provider;
  process.env.OLLAMA_TIMEOUT_MS = String(option(args, '--timeout-ms', 600000));
  const llm = llmConfig();
  if (llm.provider === 'anthropic') throw new Error('eval:retry is for local runs; it will not call a paid API');
  const systemId = option(args, '--system', 'full_context');
  const system = S.SYSTEMS.find((s) => s.id === systemId);
  if (!system || systemId !== 'full_context') throw new Error('eval:retry only repairs the full_context system (it needs no memory store)');
  const wanted = option(args, '--samples') ? String(option(args, '--samples')).split(',') : null;
  const prefix = option(args, '--prefix', 'stage6-locomo-ollama-conv-');
  const all = JSON.parse(fs.readFileSync(DATA, 'utf8'));

  const out = path.join(RESULTS, `stage6e-locomo-retry-${systemId}`);
  fs.mkdirSync(out, { recursive: true });
  const journal = path.join(out, 'retried.jsonl');
  // latest result per question; a question that failed again is asked once more when the script is started again
  const latest = new Map(fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [`${r.sample}|${r.qa_index}`, r]) : []);

  const isDone = (key) => latest.has(key) && !latest.get(key).error;
  const dirs = fs.readdirSync(RESULTS).filter((d) => d.startsWith(prefix) && fs.existsSync(path.join(RESULTS, d, 'answers.csv'))).sort();
  let total = 0;
  const plan = [];
  for (const d of dirs) {
    const rows = parseCsv(fs.readFileSync(path.join(RESULTS, d, 'answers.csv'), 'utf8')).filter((r) => r.system === systemId && r.error && TIMEOUT.test(r.error));
    const sample = rows.length ? rows[0].sample : null;
    if (!sample || (wanted && !wanted.includes(sample))) continue;
    plan.push({ sample, indexes: rows.map((r) => Number(r.qa_index)), folder: d });
    total += rows.length;
  }
  console.log(`${total} timed-out ${systemId} answers to ask again in ${plan.length} sample(s); ${[...latest.keys()].filter(isDone).length} already answered by an earlier retry.`);
  assertDisposable(MONGO_URI, 'eval');
  await mongoose.connect(MONGO_URI);

  for (const { sample: sid, indexes } of plan) {
    const prep = prepareLocomo(all.find((s) => s.sample_id === sid), { questions: 0, seed: 1 });
    const context = S.fullContext(prep.messages); // the same text for every question: the server reuses its prefix
    for (const index of indexes) {
      if (isDone(`${sid}|${index}`)) continue;
      const item = prep.items.find((x) => x.index === index);
      const row = await answerAndScore({ system, item, context, asOf: prep.asOf, retrievalMs: 0, score: prep.score });
      latest.set(`${sid}|${index}`, row);
      fs.appendFileSync(journal, `${JSON.stringify(row)}\n`);
      console.log(`  ${sid} #${index}: ${row.error ? `FAILED again (${row.error.slice(0, 70)})` : `answered, judge ${row.judge_correct}`}`);
    }
  }

  await mongoose.disconnect();
  const rows = [...latest.values()];
  fs.writeFileSync(path.join(out, 'answers.csv'), toCsv(rows));
  const failed = rows.filter((r) => r.error).length;
  fs.writeFileSync(path.join(out, 'meta.txt'), [
    `retry of the timed-out ${systemId} answers of the finished LoCoMo runs (dataset: benchmark, LoCoMo). The original run folders are unchanged.`,
    `command: ${command('eval:retry', args)}`,
    `git commit: ${gitCommit()} (the code that ran; results are committed in a later commit)`,
    `date: ${new Date().toISOString()}`,
    `questions asked again: ${rows.length}; answered now: ${rows.length - failed}; failed again: ${failed}`,
    `models: answer ${llm.models.answer}, judge ${llm.models.judge}; timeout per answer ${process.env.OLLAMA_TIMEOUT_MS} ms; context window ${(llm.ollama || {}).numCtxLarge}`,
    '',
  ].join('\n'));
  console.log(`Wrote ${path.relative(process.cwd(), out)}/ (${rows.length - failed} answered, ${failed} failed again)`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
