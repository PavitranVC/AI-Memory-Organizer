const Memory = require('../../models/Memory');
const { getEmbedder, readyEmbedder, embedDocuments, memoryText } = require('./index');

// Embeds every believed memory version (current AND superseded, since ?asOf= searches old versions too) that
// has no vector from the current model: memories written before Stage 4, by the seed or the dataset loaders,
// while the provider was down, or under a different model. Safe to re-run: done rows are skipped.
// The vector is derived data (like an index entry), so it is written in place: no new version, no audit row,
// no updatedAt change. A new model or a new vector SIZE (the id includes it) means every row is re-embedded.
async function backfillEmbeddings({ batchSize = 100, filter = {}, provider = getEmbedder(), onProgress = () => {} } = {}) {
  await readyEmbedder(provider); // Ollama: learn the vector size first, so the id below is the real one
  const model = provider.id;
  const query = { retractedAt: null, ...filter, embeddingModel: { $ne: model } };
  const total = await Memory.countDocuments(query);
  let embedded = 0;
  let lastId = null;
  // Keyset pagination on _id, so each batch starts where the last one ended
  for (;;) {
    const docs = await Memory.find(lastId ? { ...query, _id: { $gt: lastId } } : query)
      .sort({ _id: 1 })
      .limit(batchSize)
      .select('content tags')
      .lean();
    if (docs.length === 0) break;
    const { vectors } = await embedDocuments(docs.map(memoryText), provider);
    await Memory.bulkWrite(
      docs.map((doc, i) => ({
        updateOne: { filter: { _id: doc._id }, update: { $set: { embedding: vectors[i], embeddingModel: model } }, timestamps: false },
      }))
    );
    embedded += docs.length;
    lastId = docs[docs.length - 1]._id;
    onProgress({ embedded, total });
  }
  return { model, dims: provider.dims, embedded, total };
}

module.exports = { backfillEmbeddings };
