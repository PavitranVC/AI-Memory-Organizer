// Stage 6 DBMS experiment: the main memory queries WITH and WITHOUT secondary indexes, at 10k / 100k / 1M
// SYNTHETIC memories (performance only, never accuracy; CLAUDE.md).
//   npm run bench:indexes                                  10k, 100k and 1M, 30 timed runs per query
//   npm run bench:indexes -- --sizes 10000 --repeats 10 --out /tmp/idx     a quick smoke run
// For each size, in a database of its own (MONGO_URI_BENCH, name must contain "bench"; it is DROPPED):
//   1. generate the memories with only the _id index (1 synthetic user per 1,000 memories, seed 42)
//   2. time a 10,000-document insert (write cost without secondary indexes), then remove it again
//   3. run every query: explain("executionStats") on 5 parameter sets + wall-clock time of N runs
//   4. build the schema's indexes one by one, timing each, and record their sizes
//   5. repeat 2 and 3 with the indexes
// A size that runs longer than --max-minutes (default 30) is abandoned and no larger size is tried.
// Writes <out>.csv (one row per size x indexes x query), <out>-build.csv (per size: insert, index build,
// storage, write cost) and <out>.txt (command, commit, date, dataset, machine), then the charts.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Memory = require('../models/Memory');
const User = require('../models/User');
const { generateSynthetic, factChain } = require('../services/datasets/synthetic');
const { createRng } = require('../services/datasets/common');
const { CURRENT, temporalFilter } = require('../services/memoryService');
const { gitCommit, machine, command, option, assertDisposable, toCsv } = require('./meta');
const { summary, round } = require('./stats');

const MONGO_URI = process.env.MONGO_URI_BENCH || 'mongodb://127.0.0.1:27017/aimemory_bench';
const WARMUP = 3;
const EXPLAINS = 5;
const WRITE_DOCS = 10000;
const DAY = 86400000;
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;

// One parameter set per run: a random synthetic user, one of their categories, a point in time.
async function sampleParams(rng, users, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const userId = rng.pick(users);
    // A memory of this user, to borrow a real category and a version id from (served by _id order)
    const memory = await Memory.findOne({ userId }).select('_id categoryId').lean();
    const at = new Date(Date.UTC(2023, 0, 1) + rng.next() * 3 * 365 * DAY); // inside the generated valid times
    out.push({ userId, categoryId: memory.categoryId, memoryId: memory._id, at: at.toISOString(), now: new Date().toISOString() });
  }
  return out;
}

// The main queries of the app (the same list as scripts/explain.js), as functions of a parameter set.
// Each returns a Mongoose query or aggregate; "needs" names an index without which the query cannot run.
const QUERIES = [
  ['current, newest first', (p) => Memory.find({ userId: p.userId, ...CURRENT }).sort({ _id: -1 }).limit(21)],
  ['current, by status', (p) => Memory.find({ userId: p.userId, ...CURRENT, status: 'Active' }).sort({ _id: -1 }).limit(21)],
  ['current, by category', (p) => Memory.find({ userId: p.userId, ...CURRENT, categoryId: p.categoryId }).sort({ _id: -1 }).limit(21)],
  ['asOf (valid time)', (p) => Memory.find({ userId: p.userId, ...temporalFilter({ asOf: p.at }).filter }).sort({ _id: -1 }).limit(21)],
  ['knownAt (transaction time)', (p) => Memory.find({ userId: p.userId, ...temporalFilter({ knownAt: p.at }).filter }).sort({ _id: -1 }).limit(21)],
  ['asOf + knownAt (bi-temporal)', (p) => Memory.find({ userId: p.userId, ...temporalFilter({ asOf: p.at, knownAt: p.now }).filter }).sort({ _id: -1 }).limit(21)],
  ['history hop (version by _id)', (p) => Memory.find({ _id: p.memoryId, userId: p.userId })],
  // The rows the local vector backend scans for one user (Stage 4), without the embeddingModel equality
  // because the synthetic memories are not embedded here (embedding 1M rows is a separate cost, Stage 4)
  ['all current rows of a user (vector scan)', (p) => Memory.find({ userId: p.userId, ...CURRENT }).select('_id')],
  ['keyword search, current', (p) => Memory.find({ userId: p.userId, ...CURRENT, $text: { $search: 'yoga' } }), 'text'],
  ['category in use? (delete check)', (p) => Memory.find({ categoryId: p.categoryId, retractedAt: null }).limit(1)],
  ['aggregate: count by category', (p) => Memory.aggregate([{ $match: { userId: p.userId, ...CURRENT } }, { $group: { _id: '$categoryId', count: { $sum: 1 } } }])],
];

function planStages(plan, out = []) {
  if (!plan) return out;
  out.push(plan.indexName ? `${plan.stage}(${plan.indexName})` : plan.stage);
  planStages(plan.inputStage, out);
  (plan.inputStages || []).forEach((p) => planStages(p, out));
  planStages(plan.queryPlan, out);
  return out;
}

async function explainStats(build) {
  const explain = await build().explain('executionStats');
  const root = Array.isArray(explain) ? explain[0] : explain.stages ? explain.stages[0].$cursor : explain;
  const stages = planStages(root.queryPlanner.winningPlan);
  const s = root.executionStats;
  return { stages, returned: s.nReturned, keys: s.totalKeysExamined, docs: s.totalDocsExamined, execMs: s.executionTimeMillis };
}

async function runQueries({ size, indexed, params, repeats, deadline }) {
  const rows = [];
  for (const [label, build, needs] of QUERIES) {
    if (Date.now() > deadline) throw new Error('time budget exceeded');
    const base = { memories: size, indexes: indexed ? 'yes' : 'no', query: label };
    if (needs === 'text' && !indexed) {
      rows.push({ ...base, note: '$text needs a text index: cannot run without it' });
      continue;
    }
    const explains = [];
    for (const p of params.slice(0, EXPLAINS)) explains.push(await explainStats(() => build(p)));
    const times = [];
    for (let i = 0; i < WARMUP + repeats; i += 1) {
      const start = process.hrtime.bigint();
      const q = build(params[i % params.length]);
      await (q.lean ? q.lean() : q);
      if (i >= WARMUP) times.push(ms(start));
    }
    const plans = [...new Set(explains.map((e) => e.stages.join(' > ')))];
    const t = summary(times);
    const avg = (key) => round(explains.reduce((s, e) => s + e[key], 0) / explains.length, 1);
    rows.push({
      ...base,
      plan: plans.join(' | '),
      collscan: plans.some((p) => p.includes('COLLSCAN')) ? 'yes' : 'no',
      in_memory_sort: plans.some((p) => /(^|> )SORT( |$)/.test(p)) ? 'yes' : 'no',
      avg_returned: avg('returned'),
      avg_keys_examined: avg('keys'),
      avg_docs_examined: avg('docs'),
      median_exec_ms: [...explains.map((e) => e.execMs)].sort((a, b) => a - b)[Math.floor(explains.length / 2)],
      runs: t.n,
      p50_ms: t.p50,
      p95_ms: t.p95,
      mean_ms: t.mean,
      note: '',
    });
    const r = rows[rows.length - 1];
    console.log(`  ${indexed ? 'indexed' : 'no index'} | ${label}: p50 ${r.p50_ms} ms, docs examined ${r.avg_docs_examined}`);
  }
  return rows;
}

// Write cost: insert WRITE_DOCS fresh versions for one extra user (same generator), time it, remove them
async function writeCost(categories) {
  const rng = createRng(99);
  const userId = new mongoose.Types.ObjectId();
  const docs = [];
  while (docs.length < WRITE_DOCS) docs.push(...factChain(rng, userId, categories, WRITE_DOCS - docs.length));
  const start = process.hrtime.bigint();
  for (let i = 0; i < docs.length; i += 1000) await Memory.collection.insertMany(docs.slice(i, i + 1000), { ordered: false });
  const elapsed = ms(start);
  await Memory.collection.deleteMany({ userId });
  return round(elapsed / 1000, 3);
}

async function benchSize(size, { repeats, deadline }) {
  await mongoose.connection.dropDatabase();
  const started = process.hrtime.bigint();
  // autoIndex is off for this connection, so only the mandatory _id index exists after this
  const generated = await generateSynthetic({ memories: size, seed: 42, reset: true });
  const insertSeconds = ms(started) / 1000;
  const categories = await mongoose.connection.db.collection('categories').find().toArray();
  const users = (await User.find({ dataset: 'synthetic' }).select('_id').lean()).map((u) => u._id);
  const params = await sampleParams(createRng(7), users, Math.max(repeats, EXPLAINS));
  const indexesBefore = (await Memory.collection.indexes()).map((i) => i.name);
  if (indexesBefore.length !== 1) throw new Error(`expected only the _id index before the "no index" runs, found ${indexesBefore.join(', ')}`);

  console.log(`${size} memories: generated in ${round(insertSeconds, 1)} s; running without indexes`);
  const writeNoIndex = await writeCost(categories);
  const rows = await runQueries({ size, indexed: false, params, repeats, deadline });

  // Build each schema index on its own, so the cost of each one is visible
  const builds = [];
  for (const [fields, options] of Memory.schema.indexes()) {
    if (Date.now() > deadline) throw new Error('time budget exceeded');
    const start = process.hrtime.bigint();
    const { background, ...indexOptions } = options; // a legacy flag, ignored by MongoDB 4.2+
    const name = await Memory.collection.createIndex(fields, indexOptions);
    builds.push({ name, seconds: round(ms(start) / 1000, 3) });
  }
  const stats = await mongoose.connection.db.command({ collStats: 'memories' });
  const writeIndexed = await writeCost(categories);
  rows.push(...(await runQueries({ size, indexed: true, params, repeats, deadline })));

  const build = {
    memories: size,
    users: generated.users,
    current_versions: generated.current,
    superseded_versions: generated.superseded,
    retracted_versions: generated.retracted,
    generate_insert_s_no_secondary_indexes: round(insertSeconds, 2),
    data_bytes: stats.size,
    avg_doc_bytes: stats.avgObjSize,
    storage_bytes: stats.storageSize,
    id_index_bytes: stats.indexSizes._id_,
    secondary_index_bytes: stats.totalIndexSize - stats.indexSizes._id_,
    index_build_s_total: round(builds.reduce((s, b) => s + b.seconds, 0), 2),
    [`insert_${WRITE_DOCS}_s_no_index`]: writeNoIndex,
    [`insert_${WRITE_DOCS}_s_indexed`]: writeIndexed,
    index_builds: builds.map((b) => `${b.name}=${b.seconds}s/${stats.indexSizes[b.name]}B`).join(' ; '),
  };
  return { rows, build };
}

async function main() {
  const commit = gitCommit();
  const args = process.argv.slice(2);
  const sizes = String(option(args, '--sizes', '10000,100000,1000000')).split(',').map((s) => Number(s.replace(/_/g, '')));
  const repeats = Number(option(args, '--repeats', 30));
  const maxMinutes = Number(option(args, '--max-minutes', 30));
  const out = option(args, '--out', 'results/stage6-index-bench');
  if (sizes.some((n) => !Number.isInteger(n) || n < 1000) || !Number.isInteger(repeats) || repeats < 1) throw new Error('--sizes (>= 1000) and --repeats need whole numbers');
  assertDisposable(MONGO_URI, 'bench');

  // autoIndex off: Mongoose must not build the schema indexes behind our back (the "no index" runs)
  await mongoose.connect(MONGO_URI, { autoIndex: false });
  const mongoVersion = (await mongoose.connection.db.admin().serverInfo()).version;
  // Recorded so the reader can check the "warm cache" claim against data_bytes in the -build.csv
  const status = await mongoose.connection.db.admin().command({ serverStatus: 1 });
  const cacheBytes = status.wiredTiger ? status.wiredTiger.cache['maximum bytes configured'] : null;
  const rows = [];
  const builds = [];
  const notes = [];
  const writeAll = () => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (rows.length) fs.writeFileSync(`${out}.csv`, toCsv(rows, ['memories', 'indexes', 'query', 'plan', 'collscan', 'in_memory_sort', 'avg_returned', 'avg_keys_examined', 'avg_docs_examined', 'median_exec_ms', 'runs', 'p50_ms', 'p95_ms', 'mean_ms', 'note']));
    if (builds.length) fs.writeFileSync(`${out}-build.csv`, toCsv(builds));
    fs.writeFileSync(
      `${out}.txt`,
      [
        'Stage 6 index benchmark: main memory queries with and without secondary indexes',
        `command: ${command('bench:indexes', args)}`,
        `git commit: ${commit} (the code that ran; results are committed in a later commit)`,
        `date: ${new Date().toISOString()}`,
        'dataset: SYNTHETIC (services/datasets/synthetic.js, seed 42, 1 user per 1,000 memories). Performance numbers only, never accuracy.',
        `sizes asked: ${sizes.join(', ')}; time budget per size: ${maxMinutes} min`,
        `per query: explain("executionStats") on ${EXPLAINS} parameter sets (random user, category, time; seed 7), averaged;`,
        `  then ${repeats} timed runs after ${WARMUP} warm-up runs (wall-clock in Node: query + network + decoding), nearest-rank percentiles`,
        '"no" = only the _id index; "yes" = every index declared in models/Memory.js, built after loading.',
        `write cost: ${WRITE_DOCS} extra versions inserted in batches of 1,000 and then removed, without and with the indexes`,
        `single run, warm cache (WiredTiger cache: ${cacheBytes} bytes; compare data_bytes in the -build.csv); MongoDB in Docker on the same machine`,
        `machine: ${machine()}`,
        `node: ${process.version}; mongodb: ${mongoVersion}`,
        ...(notes.length ? ['', 'NOTES:', ...notes] : []),
        '',
      ].join('\n')
    );
  };

  for (const size of sizes) {
    const started = Date.now();
    try {
      const result = await benchSize(size, { repeats, deadline: started + maxMinutes * 60000 });
      rows.push(...result.rows);
      builds.push({ ...result.build, minutes: round((Date.now() - started) / 60000, 1) });
      console.log(`${size} memories done in ${round((Date.now() - started) / 60000, 1)} min`);
    } catch (err) {
      if (err.message !== 'time budget exceeded') throw err;
      notes.push(`${size} memories: abandoned after ${maxMinutes} minutes (the time budget); no rows are reported for it and no larger size was run.`);
      console.log(notes[notes.length - 1]);
      break;
    } finally {
      // Free the disk at once: each size is regenerated from scratch anyway
      await mongoose.connection.dropDatabase();
    }
    writeAll(); // after every size, so a crash later keeps the finished sizes
  }
  writeAll();
  console.log(`Wrote ${out}.csv, ${out}-build.csv and ${out}.txt`);
  await mongoose.disconnect();
  if (rows.length) require('./charts').indexCharts(out);
}

main().catch(async (err) => {
  console.error(err.stack || err.message);
  try {
    await mongoose.connection.dropDatabase();
  } catch (e) {
    // not connected
  }
  await mongoose.disconnect();
  process.exit(1);
});
