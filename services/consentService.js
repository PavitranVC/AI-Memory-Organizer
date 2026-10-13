// Consent hook for the extractor (Stage 3). Stage 7 adds per-category consent settings ("never store health
// facts"); until then every category is allowed. The extractor already calls this before storing any fact, so
// Stage 7 only has to change this function, not the pipeline.
// eslint-disable-next-line no-unused-vars
async function allowsCategory(userId, categoryName) {
  return true;
}

module.exports = { allowsCategory };
