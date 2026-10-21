// Checks every condition, starts the batch (eval/run-batch.js) as a DETACHED background process, confirms that it
// is running, and exits. Nothing keeps waiting: the batch carries on by itself, checkpointing and backing up to git
// after every question. Close this terminal or the agent that started it, the batch keeps going.
//   npm run eval:launch -- --batch-id stage6c-lme-pilot --types knowledge-update,temporal-reasoning --per-type 12
// Check on it later with: npm run eval:status
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { option } = require('./meta');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--check-only');
  const batchId = option(args, '--batch-id', 'stage6c-lme-pilot');
  const batch = path.join(__dirname, 'run-batch.js');

  // 1. the conditions, in the foreground, so a failure is seen at once and nothing was started
  const check = spawnSync(process.execPath, [batch, ...args, '--check-only'], { cwd: ROOT, stdio: 'inherit' });
  if (check.status !== 0) {
    console.error('Not launched: a condition failed (see above). Nothing is running.');
    process.exit(1);
  }

  // 2. the batch itself, detached from this process
  const logDir = path.join(ROOT, 'results', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `${batchId}.console.log`), 'a');
  const child = spawn(process.execPath, [batch, ...args], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();

  // 3. one short confirmation (at most 45 s), then leave
  const statusFile = path.join(ROOT, 'results', `${batchId}-status.json`);
  for (let i = 0; i < 45; i += 1) {
    await sleep(1000);
    if (fs.existsSync(statusFile)) {
      const s = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      if (s.state === 'running' && s.pid === child.pid) {
        console.log(`LAUNCHED: batch ${batchId} is running in the background (pid ${s.pid}), ${s.total} questions.`);
        console.log('Check later with: npm run eval:status    (and: git fetch; git log origin/<branch> --oneline -5)');
        console.log('If it stops, run the same command again: finished questions are skipped, the interrupted one continues.');
        return;
      }
    }
    if (child.exitCode !== null) break;
  }
  console.error(`The batch did not report "running" within 45 s. Look at results/logs/${batchId}.console.log and results/logs/${batchId}.log.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
