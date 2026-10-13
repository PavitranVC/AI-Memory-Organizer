const Memory = require('../../models/Memory');
const { cosine } = require('../../services/embeddings');
const index = require('../../atlas/vector-index.json');

// An EMULATOR of MongoDB Atlas $vectorSearch for the tests (there is no Atlas in CI). It is not Atlas: it does
// an exact search where Atlas does an approximate (HNSW) one. It checks that the pipeline we send is one
// Atlas would accept for the committed index (atlas/vector-index.json), then evaluates it:
//   - the index name and vector path match the index; numCandidates is between limit and 10,000;
//   - every pre-filter field is declared as a "filter" field, with operators Atlas supports;
//   - the score is (1 + cosine) / 2, Atlas's definition for the cosine similarity;
//   - every stage after $vectorSearch runs on the real MongoDB unchanged.
const vectorField = index.definition.fields.find((f) => f.type === 'vector');
const filterPaths = new Set(index.definition.fields.filter((f) => f.type === 'filter').map((f) => f.path));
const OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin']);

function checkFilter(filter) {
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') value.forEach(checkFilter);
    else if (key.startsWith('$')) throw new Error(`$vectorSearch filter: unsupported operator ${key}`);
    else {
      if (!filterPaths.has(key)) throw new Error(`$vectorSearch filter: "${key}" is not a filter field of the index`);
      for (const op of Object.keys(value)) if (!OPERATORS.has(op)) throw new Error(`$vectorSearch filter: unsupported operator ${op} on ${key}`);
      if (Object.values(value).some((v) => v === null)) throw new Error(`$vectorSearch filter: null on ${key} (not relied upon)`);
    }
  }
}

async function emulateAtlas(pipeline) {
  const [first, second, ...rest] = pipeline;
  const vs = first && first.$vectorSearch;
  if (!vs) throw new Error('$vectorSearch must be the first stage');
  if (vs.index !== index.name) throw new Error(`unknown index ${vs.index}`);
  if (vs.path !== vectorField.path) throw new Error(`path ${vs.path} is not the vector field`);
  if (!(vs.numCandidates >= vs.limit && vs.numCandidates <= 10000)) throw new Error('numCandidates must be >= limit and <= 10000');
  checkFilter(vs.filter);
  if (JSON.stringify(second) !== JSON.stringify({ $addFields: { vectorScore: { $meta: 'vectorSearchScore' } } })) {
    throw new Error('the second stage must read the score with $meta: "vectorSearchScore"');
  }

  const docs = await Memory.find(vs.filter).select('+embedding').lean();
  const ranked = docs
    .filter((d) => Array.isArray(d.embedding) && d.embedding.length === vs.queryVector.length)
    .map((d) => ({ _id: d._id, score: (1 + cosine(vs.queryVector, d.embedding)) / 2 }))
    .sort((a, b) => b.score - a.score || String(a._id).localeCompare(String(b._id)))
    .slice(0, vs.limit);
  if (ranked.length === 0) return [];
  const ids = ranked.map((r) => r._id);
  const scores = ranked.map((r) => r.score);
  return Memory.aggregate([
    { $match: { _id: { $in: ids } } },
    { $addFields: { vectorScore: { $arrayElemAt: [scores, { $indexOfArray: [ids, '$_id'] }] } } },
    { $sort: { vectorScore: -1, _id: 1 } },
    ...rest,
  ]);
}

module.exports = { emulateAtlas, index };
