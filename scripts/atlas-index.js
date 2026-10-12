// Creates the Atlas Vector Search index from atlas/vector-index.json, with numDimensions set to the
// configured embedder's size. Only works against a MongoDB ATLAS cluster (MONGO_URI=mongodb+srv://...);
// a local MongoDB has no vector search. Not run in CI or in the cloud session (no Atlas there).
//   npm run atlas:index            create the index (it takes a minute or so to become READY)
//   npm run atlas:index -- --print print the definition only, connect to nothing
require('dotenv').config();
const mongoose = require('mongoose');
const definition = require('../atlas/vector-index.json');
const { getEmbedder } = require('../services/embeddings');

async function main() {
  const embedder = getEmbedder();
  const fields = definition.definition.fields.map((f) => (f.type === 'vector' ? { ...f, numDimensions: embedder.dims } : f));
  const index = { name: definition.name, type: definition.type, definition: { fields } };
  console.log(`Embedder: ${embedder.id} (${embedder.dims} dimensions)`);
  console.log(JSON.stringify(index, null, 2));
  if (process.argv.includes('--print')) return;

  if (!process.env.MONGO_URI || !process.env.MONGO_URI.startsWith('mongodb+srv://')) {
    throw new Error('MONGO_URI must point at an Atlas cluster (mongodb+srv://...). Use --print to see the definition only.');
  }
  await mongoose.connect(process.env.MONGO_URI);
  const collection = mongoose.connection.db.collection(definition.collection);
  await collection.createSearchIndex(index);
  console.log(`Requested index "${index.name}" on ${definition.collection}. Check its status in the Atlas UI (Search tab) until it is READY.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect();
  process.exit(1);
});
