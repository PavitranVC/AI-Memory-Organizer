// Retrieval latency benchmark on SYNTHETIC memories (performance only, never accuracy; CLAUDE.md).
//   npm run bench:retrieval                                    1k and 10k memories, 200 queries each
//   npm run bench:retrieval -- --sizes 1000,10000 --queries 200 --out results/stage4-retrieval-latency
// For each size it generates the memories for ONE synthetic user (the worst case for the brute-force local
// backend, which scans all of a user's memories), embeds them with the offline lexical embedder, then times
// hybrid retrieval for random questions, now and ?asOf= a past date. Writes <out>.csv (numbers) and
// <out>.txt (command, git commit, date, machine, dataset). Uses its own database (MONGO_URI_BENCH, which
// must contain "bench" in its name) and DROPS it first.
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const mongoose = require('mongoose');
const Memory = require('../models/Memory');
const { generateSynthetic } = require('../services/datasets/synthetic');
const { createRng } = require('../services/datasets/common');
const { backfillEmbeddings } = require('../services/embeddings/backfill');
const embeddings = require('../services/embeddings');
const { LexicalEmbeddingProvider } = require('../services/embeddings/lexicalProvider');
const { retrieve } = require('../services/retrieval');
const { retrievalConfig } = require('../services/retrieval/config');
const vectorStore = require('../services/retrieval/vectorStore');
const { temporalFilter, CURRENT } = require('../services/memoryService');

const MONGO_URI = process.env.MONGO_URI_BENCH || 'mongodb://127.0.0.1:27017/aimemory_bench';
const WARMUP = 10;
// Questions about the synthetic generator's topics (services/datasets/synthetic.js)
const TOPICS = ['rock climbing', 'Spanish', 'MongoDB indexing', 'spicy food', 'the guitar', 'marathon training', 'a trip to Goa', 'oat milk',
  'machine learning', 'watercolour painting', 'night shifts', 'a vegetarian diet', 'chess openings', 'the new apartment', 'yoga', 'Kotlin'];
const FORMS = ['What do I think about TOPIC?', 'Do I like TOPIC?', 'Who is learning TOPIC?', 'Tell me about TOPIC', 'TOPIC'];

function option(args, name, fallback) {
  return args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
}

// Nearest-rank percentile: the smallest value with at least p% of the samples at or below it
function percentile(sorted, p) {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;
const r2 = (x) => Math.round(x * 100) / 100;
const summary = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: r2(percentile(sorted, 50)), p95: r2(percentile(sorted, 95)), mean: r2(samples.reduce((s, x) => s + x, 0) / samples.length) };
};

async function timeQueries({ userId, queries, asOfs, config }) {
  const total = [];
  const vector = [];
  const text = [];
  for (let i = 0; i < queries.length; i += 1) {
    const query = queries[i];
    const asOf = asOfs ? asOfs[i] : undefined;
    const measured = i >= WARMUP;
    // The whole hybrid retrieval, as /api/ask runs it (including the access-count update)
    let start = process.hrtime.bigint();
    await retrieve(userId, { query, asOf, config });
    if (measured) total.push(ms(start));
    // Its two candidate searches on their own
    const { filter: temporal, asOf: at } = temporalFilter(asOf ? { asOf } : {});
    const { vector: queryVector, model } = await embeddings.embedQuery(query);
    start = process.hrtime.bigint();
    await vectorStore.search('local', { userId, temporal, at: at || new Date(), queryVector, model, limit: config.candidates });
    if (measured) vector.push(ms(start));
    start = process.hrtime.bigint();
    await Memory.find({ userId, ...temporal, $text: { $search: query } }, { score: { $meta: 'textScore' } }).sort({ score: { $meta: 'textScore' } }).limit(config.candidates).select('_id').lean();
    if (measured) text.push(ms(start));
  }
  return { total: summary(total), vector: summary(vector), text: summary(text), n: total.length };
}

// The commit that runs, read BEFORE any result file is written (a rewritten results file would look like an
// uncommitted change)
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

async function main() {
  const commit = gitCommit();
  const args = process.argv.slice(2);
  const sizes = String(option(args, '--sizes', '1000,10000')).split(',').map(Number);
  const queryCount = Number(option(args, '--queries', 200));
  const out = option(args, '--out', 'results/stage4-retrieval-latency');
  if (sizes.some((n) => !Number.isInteger(n) || n < 10) || !Number.isInteger(queryCount) || queryCount < 1) throw new Error('--sizes and --queries need whole numbers');
  if (!/bench/.test(new URL(MONGO_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)) throw new Error('MONGO_URI_BENCH must name a database containing "bench" (it is dropped)');

  // Tonight's rule: no paid calls. The benchmark always uses the offline lexical embedder.
  const embedder = new LexicalEmbeddingProvider();
  embeddings.setEmbedder(embedder);
  const config = { ...retrievalConfig(), backend: 'local' };

  await mongoose.connect(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await Memory.init();
  const mongoVersion = (await mongoose.connection.db.admin().serverInfo()).version;

  const rows = [];
  for (const size of sizes) {
    const generated = await generateSynthetic({ memories: size, users: 1, seed: 42, reset: true });
    let start = process.hrtime.bigint();
    const embedded = await backfillEmbeddings({ provider: embedder, filter: { dataset: 'synthetic' }, batchSize: 128 });
    const embedSeconds = ms(start) / 1000;
    const userId = (await Memory.findOne({ dataset: 'synthetic' }).select('userId').lean()).userId;
    const current = await Memory.countDocuments({ userId, ...CURRENT });
    const [sizes2] = await Memory.aggregate([
      { $match: { userId, embeddingModel: embedder.id } },
      { $group: { _id: null, doc: { $avg: { $bsonSize: '$$ROOT' } }, emb: { $avg: { $bsonSize: { e: '$embedding' } } } } },
    ]);

    const rng = createRng(7);
    const queries = Array.from({ length: queryCount + WARMUP }, () => rng.pick(FORMS).replace('TOPIC', rng.pick(TOPICS)));
    // Past dates inside the generated valid-time range (2023 to 2025)
    const asOfs = queries.map(() => new Date(Date.UTC(2023, 0, 1) + rng.next() * 3 * 365 * 86400000).toISOString());

    for (const [mode, dates] of [['current', null], ['asOf', asOfs]]) {
      const t = await timeQueries({ userId, queries, asOfs: dates, config });
      rows.push({
        dataset: 'synthetic',
        memories: generated.memories,
        users: 1,
        current_memories: current,
        mode,
        backend: 'local',
        embedder: embedder.id,
        k: config.topK,
        candidates: config.candidates,
        queries: t.n,
        p50_ms: t.total.p50,
        p95_ms: t.total.p95,
        mean_ms: t.total.mean,
        vector_p50_ms: t.vector.p50,
        vector_p95_ms: t.vector.p95,
        text_p50_ms: t.text.p50,
        text_p95_ms: t.text.p95,
        embed_backfill_s: r2(embedSeconds),
        embedded: embedded.embedded,
        avg_doc_bytes: Math.round(sizes2.doc),
        avg_embedding_bytes: Math.round(sizes2.emb),
      });
      const last = rows[rows.length - 1];
      console.log(`${size} memories, ${mode}: p50 ${last.p50_ms} ms, p95 ${last.p95_ms} ms (vector p95 ${last.vector_p95_ms} ms, text p95 ${last.text_p95_ms} ms)`);
    }
  }

  const header = Object.keys(rows[0]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${out}.csv`, [header.join(','), ...rows.map((r) => header.map((h) => r[h]).join(','))].join('\n') + '\n');
  const cpus = os.cpus();
  fs.writeFileSync(
    `${out}.txt`,
    [
      'Stage 4 retrieval latency benchmark',
      `command: npm run bench:retrieval -- ${args.join(' ')}`.trim(),
      `git commit: ${commit} (the code that ran; results are committed in a later commit)`,
      `date: ${new Date().toISOString()}`,
      'dataset: SYNTHETIC (services/datasets/synthetic.js, seed 42, one user). Performance numbers only, never accuracy.',
      `embedder: ${embedder.id} (offline LEXICAL baseline, not a semantic model); vector backend: local brute-force cosine`,
      `retrieval: k=${config.topK}, candidates=${config.candidates}, weights=${JSON.stringify(config.weights)}`,
      `queries per row: ${queryCount} measured after ${WARMUP} warm-up queries; percentiles are nearest-rank; single run, warm cache`,
      `p50_ms/p95_ms: the whole retrieve() call; vector_*: the local vector search alone; text_*: the $text candidate query alone`,
      `machine: ${cpus.length} x ${cpus[0] ? cpus[0].model : 'unknown CPU'}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.platform()} ${os.release()}`,
      `node: ${process.version}; mongodb: ${mongoVersion} (Docker, same machine)`,
      '',
    ].join('\n')
  );
  console.log(`Wrote ${out}.csv and ${out}.txt`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});
