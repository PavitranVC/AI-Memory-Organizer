const Memory = require('../../models/Memory');
const { cosine } = require('../embeddings');

// Vector search behind one interface, with two backends (VECTOR_BACKEND):
//  - local: BRUTE-FORCE (exact) cosine over the user's memories that match the time filter. The MongoDB query
//    uses the normal indexes to find the user's rows; the similarity is computed here, in Node. Exact, but the
//    cost grows linearly with the number of memories per user.
//  - atlas: MongoDB Atlas $vectorSearch, an approximate nearest-neighbour (HNSW graph) index. Needs an Atlas
//    cluster and the index in atlas/vector-index.json. Not run in this project's tests or CI (no Atlas there);
//    its pipeline is checked against an emulator in tests/retrieval.test.js.
// Both return [{ _id, vectorScore }] best first, with vectorScore = (1 + cosine) / 2 in [0, 1], which is how
// Atlas reports cosine similarity, so the two backends' scores are directly comparable.

const toScore = (cos) => (1 + cos) / 2;
// Best first; ties broken by _id so every run (and both backends) give the same order
const byScore = (a, b) => b.vectorScore - a.vectorScore || String(a._id).localeCompare(String(b._id));

// The rows a vector search may return: the caller's own, matching the time filter, embedded by the same model
function localFilter({ userId, temporal, model }) {
  return { userId, ...temporal, embeddingModel: model };
}

async function localSearch({ userId, temporal, queryVector, model, limit }) {
  const hits = [];
  // A cursor streams the rows in batches, so 10k vectors are never all held as documents at once
  const cursor = Memory.find(localFilter({ userId, temporal, model })).select('_id +embedding').lean().cursor({ batchSize: 1000 });
  for await (const doc of cursor) hits.push({ _id: doc._id, vectorScore: toScore(cosine(queryVector, doc.embedding)) });
  return hits.sort(byScore).slice(0, limit);
}

// The $vectorSearch pipeline for Atlas.
// $vectorSearch can only PRE-filter on fields declared as "filter" in the index, and only with simple
// operators. userId, embeddingModel and validFrom <= T are safe pre-filters. The rest of the time filter
// (validTo, retractedAt, which are often null) is applied AFTER the search with a normal $match, so it does not
// depend on null support in vector filters (TODO: verify; if Atlas supports $eq null there, move it up).
// Because the post-filter can drop rows (e.g. superseded versions), the search over-fetches 4x.
function atlasPipeline({ userId, temporal, at, queryVector, model, limit, indexName }) {
  const searchLimit = Math.min(limit * 4, 1000);
  return [
    {
      $vectorSearch: {
        index: indexName,
        path: 'embedding',
        queryVector,
        // HNSW explores this many candidates; more = better recall, slower. Atlas allows at most 10,000.
        numCandidates: Math.min(searchLimit * 10, 10000),
        limit: searchLimit,
        filter: { $and: [{ userId: { $eq: userId } }, { embeddingModel: { $eq: model } }, { validFrom: { $lte: at } }] },
      },
    },
    { $addFields: { vectorScore: { $meta: 'vectorSearchScore' } } },
    { $match: localFilter({ userId, temporal, model }) },
    { $limit: limit },
    { $project: { _id: 1, vectorScore: 1 } },
  ];
}

async function atlasSearch(args, aggregate = (pipeline) => Memory.aggregate(pipeline)) {
  const rows = await aggregate(atlasPipeline(args));
  return rows.map((r) => ({ _id: r._id, vectorScore: r.vectorScore })).sort(byScore);
}

let atlasAggregate; // tests replace the Atlas call with an emulator (setAtlasAggregate)

function setAtlasAggregate(fn) {
  atlasAggregate = fn;
}

// args: { userId, temporal (filter from memoryService.temporalFilter), at (Date), queryVector, model, limit, indexName }
function search(backend, args) {
  return backend === 'atlas' ? atlasSearch(args, atlasAggregate) : localSearch(args);
}

module.exports = { search, localSearch, atlasSearch, atlasPipeline, localFilter, setAtlasAggregate, toScore };
