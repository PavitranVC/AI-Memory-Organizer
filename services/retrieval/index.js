const Memory = require('../../models/Memory');
const { badRequest } = require('../errors');
const { temporalFilter } = require('../memoryService');
const { embedQuery, cosine } = require('../embeddings');
const { retrievalConfig, parseWeights, MAX_K } = require('./config');
const vectorStore = require('./vectorStore');

// HYBRID RETRIEVAL (Stage 4): find the memories that best answer a question, at a point in time.
//
//   score = w_text * text + w_vector * vector + w_recency * recency + w_importance * importance
//
//   text        MongoDB full-text score (BM25-like term weighting, with stemming), divided by the best text
//               score among the candidates, so it lies in [0, 1]
//   vector      cosine similarity between the question's and the memory's embeddings (negative = 0)
//   recency     exponential decay: 1 for a fact that became true at the query time, 0.5 after one half-life
//   importance  (importance - 1) / 4, so 1..5 maps to 0..1
//
// Steps: (1) the time filter (valid at asOf, default now) is part of BOTH candidate queries, so a fact that was
// not true at that time can never be returned; (2) keyword candidates from the text index; (3) vector
// candidates from the vector backend; (4) union, score every candidate on all four parts, keep the relevant
// ones (some keyword match, or cosine >= minVector), sort, top k; (5) count the access on the returned rows.

const POPULATE = [{ path: 'categoryId', select: 'name' }];
const DAY = 24 * 60 * 60 * 1000;
const MAX_QUERY = 1000;
const round = (x) => Math.round(x * 10000) / 10000;

function parseK(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_K) throw badRequest(`k must be a whole number from 1 to ${MAX_K}`);
  return n;
}

// temporalFilter() takes the strings of a query string; services may also pass Dates
const asText = (value) => (value instanceof Date ? value.toISOString() : value);

async function retrieve(userId, { query, asOf, knownAt, k, weights, touch = true, config = retrievalConfig() } = {}) {
  if (typeof query !== 'string' || query.trim() === '') throw badRequest('A question (query text) is required');
  if (query.length > MAX_QUERY) throw badRequest(`The question can be at most ${MAX_QUERY} characters`);
  const text = query.trim();
  const topK = parseK(k, config.topK);
  let w;
  try {
    w = weights ? parseWeights(weights) : config.weights;
  } catch (err) {
    throw badRequest(err.message);
  }
  const { filter: temporal, asOf: asOfDate, knownAt: knownAtDate } = temporalFilter({ asOf: asText(asOf), knownAt: asText(knownAt) });
  const at = asOfDate || knownAtDate || new Date();
  const pool = Math.max(config.candidates, topK);
  const warnings = [];

  // (2) Keyword candidates: the text index has a userId prefix, so this stays inside the user's own data
  const textHits = await Memory.find({ userId, ...temporal, $text: { $search: text } }, { score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(pool)
    .select('_id')
    .lean();

  // (3) Vector candidates. If the embedding provider is down, fall back to keywords only and say so.
  let queryVector = null;
  let model = null;
  try {
    ({ vector: queryVector, model } = await embedQuery(text));
  } catch (err) {
    warnings.push(`Vector search skipped (embedding failed): ${err.message}`);
  }
  const vectorHits = queryVector
    ? await vectorStore.search(config.backend, { userId, temporal, at, queryVector, model, limit: pool, indexName: config.atlasIndex })
    : [];

  // (4) Union of both lists, then every candidate is scored on all four parts
  const ids = [...new Set([...textHits, ...vectorHits].map((h) => String(h._id)))];
  if (ids.length === 0) return { query: text, asOf: asOfDate, knownAt: knownAtDate, k: topK, weights: w, backend: config.backend, embeddingModel: model, warnings, results: [] };
  const docs = await Memory.find({ _id: { $in: ids }, userId, ...temporal }).select('+embedding').populate(POPULATE).lean();

  const maxText = Math.max(0, ...textHits.map((h) => h.score));
  const textScore = new Map(textHits.map((h) => [String(h._id), maxText > 0 ? h.score / maxText : 0]));
  const vectorScore = new Map(vectorHits.map((h) => [String(h._id), 2 * h.vectorScore - 1])); // back to cosine
  const halfLife = config.halfLifeDays * DAY;

  const scored = [];
  for (const doc of docs) {
    const id = String(doc._id);
    const parts = {
      text: textScore.get(id) || 0,
      // A keyword-only candidate outside the vector top list still gets its exact cosine
      vector: Math.max(0, vectorScore.has(id) ? vectorScore.get(id) : queryVector && doc.embeddingModel === model ? cosine(queryVector, doc.embedding) : 0),
      recency: Math.pow(0.5, Math.max(0, at - doc.validFrom) / halfLife),
      importance: ((doc.importance || 3) - 1) / 4,
    };
    if (parts.text === 0 && parts.vector < config.minVector) continue; // recent and important, but not about the question
    const score = w.text * parts.text + w.vector * parts.vector + w.recency * parts.recency + w.importance * parts.importance;
    const { embedding, ...memory } = doc;
    scored.push({ memory, score, components: parts });
  }
  // Best first; equal scores: the newer version first
  scored.sort((a, b) => b.score - a.score || String(b.memory._id).localeCompare(String(a.memory._id)));
  const results = scored.slice(0, topK);

  // (5) Usage bookkeeping (Stage 2 fields): updated in place, no new version, updatedAt untouched
  if (touch && results.length > 0) {
    const now = new Date();
    await Memory.updateMany({ _id: { $in: results.map((r) => r.memory._id) }, userId }, { $set: { lastAccessedAt: now }, $inc: { accessCount: 1 } }, { timestamps: false });
    for (const r of results) {
      r.memory.lastAccessedAt = now;
      r.memory.accessCount = (r.memory.accessCount || 0) + 1;
    }
  }

  return {
    query: text,
    asOf: asOfDate,
    knownAt: knownAtDate,
    k: topK,
    weights: w,
    backend: config.backend,
    embeddingModel: model,
    warnings,
    results: results.map((r) => ({
      memory: r.memory,
      score: round(r.score),
      components: Object.fromEntries(Object.entries(r.components).map(([key, v]) => [key, round(v)])),
    })),
  };
}

module.exports = { retrieve, parseK };
