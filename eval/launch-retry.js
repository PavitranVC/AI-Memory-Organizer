// Checks the conditions, starts `eval:retry` as a DETACHED background process that backs itself up to git, confirms
// it is running, and exits. Nothing keeps waiting.
//   npm run eval:launch-retry -- --provider ollama
// Check later with: npm run eval:retry-status
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { spawnSync } = require('child_process');
const { llmConfig } = require('../services/llm/config');
const { checkEnvironment, formatChecks } = require('./gate');
const { option } = require('./meta');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

async function main() {
  const args = process.argv.slice(2);
  const provider = option(args, '--provider', 'ollama');
  process.env.LLM_PROVIDER = provider;
  const out = path.join(ROOT, 'results', 'stage6e-locomo-retry-full_context');
  const statusFile = path.join(out, 'status.json');
  if (fs.existsSync(statusFile)) {
    const old = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (old.state === 'running' && old.pid && alive(old.pid)) {
      console.error(`Not launched: the retry is already running (pid ${old.pid}).`);
      process.exit(1);
    }
  }
  const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  const dirty = git('status', '--porcelain', '--untracked-files=no').stdout.trim();
  const llm = llmConfig();
  const env = await checkEnvironment({ llm, systems: ['full_context'], k: 10, maxItemChars: 1400, dataFile: path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'locomo', 'locomo10.json'), mongoUri: process.env.MONGO_URI_EVAL || 'mongodb://127.0.0.1:27017/aimemory_eval', samplesMessages: [] });
  const checks = [
    { name: 'git branch is not main', ok: branch !== 'main' && branch !== 'HEAD', detail: branch, blocking: true },
    { name: 'no uncommitted changes to tracked files', ok: dirty === '', detail: dirty ? 'commit or stash first' : 'clean', blocking: true },
    ...env.checks,
  ];
  console.log(`Conditions for the full-context retry:\n${formatChecks(checks)}`);
  if (!checks.every((c) => c.ok || !c.blocking)) {
    console.error('Not launched: a condition failed (see above). Nothing is running.');
    process.exit(1);
  }

  const logDir = path.join(ROOT, 'results', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'stage6e-retry.console.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'retry-failed.js'), ...args, '--backup'], { cwd: ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    if (fs.existsSync(statusFile)) {
      const s = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      if (s.pid === child.pid && (s.state === 'running' || s.state === 'done')) {
        console.log(`LAUNCHED: the full-context retry is running in the background (pid ${s.pid}), ${s.total} questions to ask again.`);
        console.log('Check later with: npm run eval:retry-status    If it stops, run the same command again: finished answers are kept.');
        return;
      }
    }
    if (child.exitCode !== null) break;
  }
  console.error('The retry did not report "running" within 60 s. See results/logs/stage6e-retry.console.log.');
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
