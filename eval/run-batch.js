// Runs a LongMemEval pilot one question at a time, with a backup after every question, and then goes quiet.
//   npm run eval:batch -- --batch-id stage6c-lme-pilot --types knowledge-update,temporal-reasoning --per-type 12
//   npm run eval:batch -- <same options> --check-only     only the conditions; starts nothing
// Options: --batch-id <name>  --provider ollama --embeddings ollama  --max-failed-in-a-row 3  --no-push
//          (and the question choice of eval/run.js: --types --per-type --ids --file --seed)
// What it guarantees:
//   1. NOTHING STARTS unless eval/gate.js passes (models installed, MongoDB replica set, worst-case prompt inside
//      the small context window, loaded model fully on the GPU, a clean git branch that is not main).
//   2. One question = one run folder = one checkpoint (eval/checkpoint.js). Starting this command again skips the
//      finished questions and continues an interrupted one.
//   3. After every finished question the folder is committed and pushed (git add results/<run> only), so a laptop
//      failure loses at most the question in progress. A failed push is logged and retried after the next question.
//   4. It stops (state "halted") when questions fail several times in a row, e.g. because Ollama died. It never
//      loops forever on a broken setup.
// Progress is written to results/<batch-id>-status.json (and committed with each backup), and the child runs log
// to results/logs/<batch-id>.log. `npm run eval:status` reads both.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { llmConfig } = require('../services/llm/config');
const { Ledger } = require('./checkpoint');
const { SYSTEM_IDS } = require('./systems');
const { selectQuestions } = require('../services/datasets/longmemeval');
const { checkEnvironment, formatChecks } = require('./gate');
const { option, gitCommit } = require('./meta');

const ROOT = path.join(__dirname, '..');
const MONGO_URI = process.env.MONGO_URI_EVAL || 'mongodb://127.0.0.1:27017/aimemory_eval';
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true }); // windowsHide: no console window flashes on Windows
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeStatus(file, status) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file); // never a half-written status file
}

// Commit this question's folder (and the status file) and try to push. Returns a short note for the status.
async function backup(runDir, statusFile, message, { push }) {
  git('add', '--', runDir, statusFile);
  const commit = git('commit', '-m', message, '--', runDir, statusFile);
  if (commit.status !== 0 && !/nothing to commit|no changes added/.test(`${commit.stdout}${commit.stderr}`)) return `commit failed: ${(commit.stderr || commit.stdout).trim().slice(0, 120)}`;
  if (!push) return 'committed (push disabled)';
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  for (let attempt = 0, wait = 2000; attempt < 4; attempt += 1, wait *= 2) {
    const pushed = git('push', '-u', 'origin', branch);
    if (pushed.status === 0) return 'committed and pushed';
    await sleep(wait);
  }
  return 'committed; push failed (will be pushed with the next backup)';
}

async function main() {
  const args = process.argv.slice(2);
  const batchId = option(args, '--batch-id', 'stage6c-lme-pilot');
  const checkOnly = args.includes('--check-only');
  const push = !args.includes('--no-push');
  const maxFailedInARow = Number(option(args, '--max-failed-in-a-row', 3));
  const provider = option(args, '--provider', 'ollama');
  const embeddings = option(args, '--embeddings', provider === 'ollama' ? 'ollama' : 'lexical');
  if (provider) process.env.LLM_PROVIDER = provider;
  if (embeddings) process.env.EMBEDDING_PROVIDER = embeddings;
  const llm = llmConfig();
  const k = 10;
  const maxItemChars = Number(option(args, '--max-item-chars', 1400));
  const systems = SYSTEM_IDS.filter((id) => id !== 'full_context');
  const statusFile = path.join('results', `${batchId}-status.json`);
  const logFile = path.join(ROOT, 'results', 'logs', `${batchId}.log`);
  const list = (name) => (option(args, name) ? String(option(args, name)).split(',') : undefined);
  const file = path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'longmemeval', option(args, '--file', 'longmemeval_s_cleaned.json'));

  // Two batches would share the one evaluation database and wreck each other: refuse to start a second
  const previous = path.join(ROOT, statusFile);
  if (fs.existsSync(previous)) {
    const old = JSON.parse(fs.readFileSync(previous, 'utf8'));
    let running = false;
    if (old.state === 'running' && old.pid && old.pid !== process.pid) {
      try {
        process.kill(old.pid, 0);
        running = true;
      } catch (err) {
        running = err.code === 'EPERM';
      }
    }
    if (running && !checkOnly) {
      console.error(`NOT STARTED: batch ${batchId} is already running (pid ${old.pid}). Use "npm run eval:status".`);
      process.exit(1);
    }
  }

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  const dirty = git('status', '--porcelain', '--untracked-files=no').stdout.trim();
  const baseChecks = [
    { name: 'git branch is not main', ok: branch !== 'main' && branch !== 'HEAD', detail: branch, blocking: true },
    { name: 'no uncommitted changes to tracked files', ok: dirty === '', detail: dirty ? `${dirty.split('\n').length} changed file(s): commit or stash them first` : 'clean', blocking: true },
  ];
  if (!fs.existsSync(file)) {
    console.error(`${file} not found: run "npm run data:download -- longmemeval" first`);
    process.exit(1);
  }
  const questions = selectQuestions(JSON.parse(fs.readFileSync(file, 'utf8')), { types: list('--types'), ids: list('--ids'), perType: option(args, '--per-type') ? Number(option(args, '--per-type')) : undefined, seed: Number(option(args, '--seed', 1)) });
  if (!questions.length) throw new Error('No LongMemEval question matches --types / --per-type / --ids');
  const { prepareLongMemEval } = require('./harness');
  const samplesMessages = questions.map((item) => prepareLongMemEval({ sample_id: item.question_id, item }).messages);

  const env = await checkEnvironment({ llm, systems, k, maxItemChars, dataFile: file, mongoUri: MONGO_URI, samplesMessages });
  const checks = [...baseChecks, ...env.checks];
  const ok = checks.every((c) => c.ok || !c.blocking);
  console.log(`Conditions for ${batchId} (${questions.length} questions):\n${formatChecks(checks)}`);
  const base = { batchId, branch, commit: gitCommit(), total: questions.length, ids: questions.map((q) => q.question_id), systems, maxItemChars };
  if (!ok) {
    writeStatus(path.join(ROOT, statusFile), { ...base, state: 'not started', reason: checks.filter((c) => !c.ok && c.blocking).map((c) => `${c.name}: ${c.detail}`) });
    console.error('\nNOT STARTED: fix the failed condition(s) above and run the command again.');
    process.exit(1);
  }
  if (checkOnly) {
    console.log('\nAll conditions pass. (--check-only: nothing was started.)');
    return;
  }

  const status = { ...base, state: 'running', pid: process.pid, startedAt: new Date().toISOString(), done: [], current: null, failedInARow: 0, lastBackup: null, durations: {} };
  const save = () => writeStatus(path.join(ROOT, statusFile), status);
  save();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.openSync(logFile, 'a');
  const say = (line) => fs.writeSync(log, `[${new Date().toISOString()}] ${line}\n`);
  say(`batch ${batchId} started: ${questions.length} questions, pid ${process.pid}`);

  let stopped = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopped = true;
      status.state = 'stopped';
      save();
      say(`stopped by ${signal}; run the same command again to continue`);
      process.exit(130);
    });
  }

  for (const item of questions) {
    const id = item.question_id;
    const runId = `${batchId}-${id}`;
    const runDir = path.join('results', runId);
    if (Ledger.inspect(path.join(ROOT, runDir)).complete) {
      status.done.push(id);
      continue;
    }
    status.current = id;
    save();
    const began = Date.now();
    let success = false;
    for (let attempt = 1; attempt <= 3 && !success && !stopped; attempt += 1) {
      say(`${id}: attempt ${attempt}`);
      const child = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), '--dataset', 'longmemeval', '--file', path.basename(file), '--ids', id, '--provider', provider, '--embeddings', embeddings, '--judge-sample', '5', '--max-item-chars', String(maxItemChars), '--run-id', runId], { cwd: ROOT, stdio: ['ignore', log, log], env: process.env, windowsHide: true });
      success = child.status === 0 && Ledger.inspect(path.join(ROOT, runDir)).complete;
      if (!success) await sleep(15000); // give Ollama a moment before the run continues from its checkpoint
    }
    status.durations[id] = Math.round((Date.now() - began) / 1000);
    if (success) {
      status.done.push(id);
      status.failedInARow = 0;
    } else {
      status.failedInARow += 1;
      say(`${id}: FAILED after 3 attempts`);
    }
    status.current = null;
    status.lastBackup = await backup(runDir, statusFile, `LongMemEval pilot: ${success ? 'finished' : 'FAILED'} question ${id} (${status.done.length}/${status.total})`, { push });
    save();
    say(`${id}: ${success ? 'done' : 'failed'}; ${status.lastBackup}`);
    if (status.failedInARow >= maxFailedInARow) {
      status.state = 'halted';
      status.reason = `${status.failedInARow} questions failed in a row (is Ollama running?)`;
      save();
      await backup(runDir, statusFile, `LongMemEval pilot halted: ${status.reason}`, { push });
      say(status.reason);
      process.exit(2);
    }
  }
  status.state = status.done.length === status.total ? 'done' : 'finished with failures';
  save();
  say(`batch ${batchId}: ${status.state} (${status.done.length}/${status.total})`);
  await backup('results', statusFile, `LongMemEval pilot ${status.state}`, { push });
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
