// Stage 6b: the checkpoint ledger of an evaluation run (results/<run-id>/checkpoint.jsonl).
// Every finished result is appended as ONE line the moment it exists, so a run that is stopped (closed lid, power
// cut, Ctrl+C, crash) loses at most the answer it was working on. Starting the same command again replays the
// file and continues. The file is plain JSON lines, one event per line:
//   run         first line: the fingerprint of the run (models, prompts, samples, questions, k, seed, systems)
//   resume      the run was started again on an existing ledger (time and commit, for meta.txt)
//   row         one finished (system x question): the whole answers.csv row, including the judge verdict
//   build       a finished store build or size record (what build.csv shows)
//   data        the sample's users are in MongoDB (their ids), which starts a new store history for the sample
//   store_start / store_built   a memory store began / finished building (with its number of memory versions)
//   discard     rows and builds of a store group were thrown away, to be redone from one clean build
//   cache       one extraction result (the overwrite store reuses the bitemporal store's extractions)
//   cache_reset the extraction cache was emptied (a bitemporal store is being rebuilt from scratch)
//   sample_done / complete
// The ledger is the only state. Nothing here changes what is measured: a resumed run asks the same questions with
// the same prompts, and a fingerprint mismatch (another model, prompt, k, seed...) refuses to resume.
const fs = require('fs');
const path = require('path');

const FILE = 'checkpoint.jsonl';

// undefined would be dropped by JSON.stringify and change a row's columns, so it is written as null
const replacer = (key, value) => (value === undefined ? null : value);

class PersistentCache extends Map {
  constructor(ledger, sample, entries) {
    super();
    this.ledger = ledger;
    this.sample = sample;
    // the entries come from the ledger itself: fill them without writing them again
    for (const [key, data] of entries) Map.prototype.set.call(this, key, data);
  }

  set(key, data) {
    if (!this.has(key)) this.ledger.append({ type: 'cache', sample: this.sample, key, data });
    return super.set(key, data);
  }
}

function emptySample() {
  return { rows: new Map(), builds: new Map(), data: null, lastStore: null, cache: new Map(), done: false };
}

// Reads a ledger file into memory. Safe on a file whose last line was cut off by a crash: that line is skipped
// (and counted in badLines), because only a complete line was ever acknowledged as written.
function replay(file) {
  const state = { header: null, resumes: [], samples: new Map(), complete: false, badLines: 0, lines: 0 };
  if (!fs.existsSync(file)) return state;
  const sampleOf = (id) => {
    if (!state.samples.has(id)) state.samples.set(id, emptySample());
    return state.samples.get(id);
  };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch (err) {
      state.badLines += 1;
      continue;
    }
    state.lines += 1;
    if (e.type === 'run') state.header = e;
    else if (e.type === 'resume') state.resumes.push(e);
    else if (e.type === 'row') sampleOf(e.row.sample).rows.set(`${e.row.system}|${e.row.qa_index}`, e.row);
    else if (e.type === 'build') sampleOf(e.sample).builds.set(e.build.store, e.build);
    else if (e.type === 'data') {
      // new users in the database: whatever store was there before is gone
      const s = sampleOf(e.sample);
      s.data = { userIds: e.userIds };
      s.lastStore = null;
    } else if (e.type === 'store_start') sampleOf(e.sample).lastStore = { store: e.store, built: false };
    else if (e.type === 'store_built') sampleOf(e.sample).lastStore = { store: e.store, built: true, versions: e.versions };
    else if (e.type === 'discard') {
      const s = sampleOf(e.sample);
      for (const id of e.systems) for (const key of [...s.rows.keys()]) if (key.startsWith(`${id}|`)) s.rows.delete(key);
      for (const store of e.builds) s.builds.delete(store);
    } else if (e.type === 'cache') sampleOf(e.sample).cache.set(e.key, e.data);
    else if (e.type === 'cache_reset') sampleOf(e.sample).cache.clear();
    else if (e.type === 'sample_done') sampleOf(e.sample).done = true;
    else if (e.type === 'complete') state.complete = true;
  }
  return state;
}

// Names the fingerprint fields that differ, for the refusal message
function differences(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].filter((k) => JSON.stringify(a ? a[k] : undefined) !== JSON.stringify(b ? b[k] : undefined));
}

class Ledger {
  constructor(file, state) {
    this.file = file;
    this.state = state;
    this.resumed = state.lines > 0;
  }

  // Opens (or starts) the ledger of a run directory.
  //   restart: keep the old file as checkpoint.<time>.jsonl.bak and start again from nothing
  static open(dir, fingerprint, { restart = false, commit = 'unknown', now = () => new Date() } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FILE);
    if (restart && fs.existsSync(file)) fs.renameSync(file, path.join(dir, `checkpoint.${now().toISOString().replace(/[:.]/g, '-')}.jsonl.bak`));
    const state = replay(file);
    const ledger = new Ledger(file, state);
    if (state.header) {
      const diff = differences(state.header.fingerprint, fingerprint);
      if (diff.length) {
        throw new Error(`${file} was written by a run with different settings (${diff.join(', ')}). Resuming it would mix two different experiments. Use a new --run-id, or --restart to set the old checkpoint aside and start again.`);
      }
      // a crash can leave a half-written last line: end it, so the next event starts on a line of its own
      const text = fs.readFileSync(file, 'utf8');
      if (text.length && !text.endsWith('\n')) fs.appendFileSync(file, '\n');
      ledger.append({ type: 'resume', at: now().toISOString(), commit });
      state.resumes.push({ type: 'resume', at: now().toISOString(), commit });
    } else {
      ledger.append({ type: 'run', at: now().toISOString(), commit, fingerprint });
      state.header = { type: 'run', at: now().toISOString(), commit, fingerprint };
    }
    return ledger;
  }

  // The ledger of a run, read without writing anything (for --resume-check)
  static inspect(dir) {
    return replay(path.join(dir, FILE));
  }

  // One write, flushed to disk before returning: a line that was acknowledged survives a crash
  append(event) {
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(event, replacer)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  sample(id) {
    if (!this.state.samples.has(id)) this.state.samples.set(id, emptySample());
    return this.state.samples.get(id);
  }

  rowsFor(id) {
    return this.sample(id).rows;
  }

  addRow(row) {
    this.append({ type: 'row', row });
    this.sample(row.sample).rows.set(`${row.system}|${row.qa_index}`, JSON.parse(JSON.stringify(row, replacer)));
  }

  buildOf(id, store) {
    return this.sample(id).builds.get(store) || null;
  }

  addBuild(id, build) {
    this.append({ type: 'build', sample: id, build });
    this.sample(id).builds.set(build.store, build);
  }

  dataOf(id) {
    return this.sample(id).data;
  }

  setData(id, userIds) {
    this.append({ type: 'data', sample: id, userIds });
    const s = this.sample(id);
    s.data = { userIds };
    s.lastStore = null;
  }

  lastStore(id) {
    return this.sample(id).lastStore;
  }

  storeStart(id, store) {
    this.append({ type: 'store_start', sample: id, store });
    this.sample(id).lastStore = { store, built: false };
  }

  storeBuilt(id, store, versions) {
    this.append({ type: 'store_built', sample: id, store, versions });
    this.sample(id).lastStore = { store, built: true, versions };
  }

  discard(id, { systems, builds }) {
    this.append({ type: 'discard', sample: id, systems, builds });
    const s = this.sample(id);
    for (const system of systems) for (const key of [...s.rows.keys()]) if (key.startsWith(`${system}|`)) s.rows.delete(key);
    for (const store of builds) s.builds.delete(store);
  }

  cacheFor(id) {
    return new PersistentCache(this, id, this.sample(id).cache);
  }

  resetCache(id) {
    this.append({ type: 'cache_reset', sample: id });
    this.sample(id).cache.clear();
  }

  isDone(id) {
    return this.sample(id).done;
  }

  markDone(id) {
    if (this.sample(id).done) return;
    this.append({ type: 'sample_done', sample: id });
    this.sample(id).done = true;
  }

  complete(now = () => new Date()) {
    this.append({ type: 'complete', at: now().toISOString() });
    this.state.complete = true;
  }

  // For meta.txt: when the run started, and each time it was started again
  history() {
    return { startedAt: this.state.header ? this.state.header.at : null, resumes: this.state.resumes.map((r) => ({ at: r.at, commit: r.commit })) };
  }
}

module.exports = { Ledger, replay, differences, FILE };
