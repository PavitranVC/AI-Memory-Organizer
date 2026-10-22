// Where is the run? Reads the batch status file, whether its process is alive, the last log lines and git.
//   npm run eval:status                         (default batch stage6c-lme-pilot)
//   npm run eval:status -- --batch-id <name>
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { option } = require('./meta');

const ROOT = path.join(__dirname, '..');
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).stdout.trim();
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};
const hours = (s) => `${(s / 3600).toFixed(1)} h`;

function main() {
  const batchId = option(process.argv.slice(2), '--batch-id', 'stage6c-lme-pilot');
  const file = path.join(ROOT, 'results', `${batchId}-status.json`);
  if (!fs.existsSync(file)) {
    console.log(`No status file for "${batchId}" yet (results/${batchId}-status.json). The batch has not been started, or git pull has not brought it.`);
  } else {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    const running = s.state === 'running';
    const pidAlive = s.pid ? alive(s.pid) : false;
    console.log(`batch ${s.batchId}: ${s.state}${running && !pidAlive ? ' (BUT the process is not running here: it died, or this is another machine; run the batch command again to continue)' : ''}`);
    console.log(`  questions finished ${s.done ? s.done.length : 0} of ${s.total}; current ${s.current || '-'}; failed in a row ${s.failedInARow || 0}`);
    const times = Object.values(s.durations || {});
    if (times.length) {
      const average = times.reduce((a, b) => a + b, 0) / times.length;
      console.log(`  average ${(average / 60).toFixed(0)} min per question; about ${hours(average * (s.total - s.done.length))} left at that pace`);
    }
    if (s.reason) console.log(`  reason: ${Array.isArray(s.reason) ? s.reason.join('; ') : s.reason}`);
    if (s.lastBackup) console.log(`  last backup: ${s.lastBackup}`);
    console.log(`  status written ${s.updatedAt}`);
    const logFile = path.join(ROOT, 'results', 'logs', `${batchId}.log`);
    if (fs.existsSync(logFile)) console.log(`  last log lines:\n${fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-5).map((l) => `    ${l.slice(0, 180)}`).join('\n')}`);
  }
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const ahead = git('rev-list', '--count', `origin/${branch}..HEAD`);
  console.log(`git: branch ${branch}; ${ahead || '?'} commit(s) not pushed; ${git('status', '--porcelain', '--untracked-files=no') ? 'uncommitted changes' : 'tracked files clean'}; last commit: ${git('log', '-1', '--format=%h %s')}`);
}

main();
