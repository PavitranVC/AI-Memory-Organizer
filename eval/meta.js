const os = require('os');
const { execSync } = require('child_process');

// Facts every result file records (CLAUDE.md, "Data and results honesty"): the commit that ran, the machine,
// and the exact command. Shared by the Stage 6 scripts.

// The commit that runs, read BEFORE any result file is written (a rewritten results file would otherwise look
// like an uncommitted change). "+ uncommitted changes" means the code that ran is not exactly that commit.
function gitCommit() {
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    commit += dirty ? ' + uncommitted changes' : '';
  } catch (err) {
    // not a git checkout
  }
  return commit;
}

function machine() {
  const cpus = os.cpus();
  return `${cpus.length} x ${cpus[0] ? cpus[0].model : 'unknown CPU'}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.platform()} ${os.release()}`;
}

// "npm run <script> -- <args>" as the user would type it
function command(script, args) {
  return `npm run ${script}${args.length ? ` -- ${args.join(' ')}` : ''}`;
}

function option(args, name, fallback) {
  return args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
}

// A database the script may DROP must say so in its name, so a typo can never wipe real data
function assertDisposable(uri, word) {
  const name = new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')).pathname;
  if (!name.includes(word)) throw new Error(`The database in ${uri} must contain "${word}" in its name (this script drops it)`);
}

// CSV with quoting only where needed (commas, quotes, newlines)
function toCsv(rows, header = Object.keys(rows[0] || {})) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(','), ...rows.map((r) => header.map((h) => cell(r[h])).join(','))].join('\n') + '\n';
}

// The reverse of toCsv (quoted cells, "" inside quotes). Numbers stay strings; callers convert.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

module.exports = { gitCommit, machine, command, option, assertDisposable, toCsv, parseCsv };
