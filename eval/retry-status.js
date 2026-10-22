// Where is the full-context retry?   npm run eval:retry-status
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const file = path.join(ROOT, 'results', 'stage6e-locomo-retry-full_context', 'status.json');
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).stdout.trim();
if (!fs.existsSync(file)) {
  console.log('No status file yet: the retry has not been started (or git pull has not brought it).');
} else {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  let alive = false;
  try {
    process.kill(s.pid, 0);
    alive = true;
  } catch (err) {
    alive = err.code === 'EPERM';
  }
  console.log(`retry: ${s.state}${s.state === 'running' && !alive ? ' (BUT the process is not running here: it died, or this is another machine; run the launch command again)' : ''}`);
  console.log(`  ${s.answered + s.failedAgain} of ${s.total} asked again (${s.answered} answered, ${s.failedAgain} failed again); current ${s.current || '-'}`);
  console.log(`  last backup: ${s.lastBackup || '-'}; status written ${s.updatedAt}`);
  const log = path.join(ROOT, 'results', 'logs', 'stage6e-retry.console.log');
  if (fs.existsSync(log)) console.log(`  last log lines:\n${fs.readFileSync(log, 'utf8').trim().split('\n').slice(-4).map((l) => `    ${l.slice(0, 160)}`).join('\n')}`);
}
console.log(`git: branch ${git('rev-parse', '--abbrev-ref', 'HEAD')}; last commit: ${git('log', '-1', '--format=%h %s')}`);
