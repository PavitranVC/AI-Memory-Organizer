const { fnv1a, tokenize, normalize } = require('./hashing');

// The offline LEXICAL embedder: a hashed bag of words and character trigrams, weighted by sublinear term
// frequency (1 + log tf) and scaled to length 1. It needs no network, no key and no model download, so the
// app works fully offline (the default, EMBEDDING_PROVIDER=lexical).
//
// It is a LEXICAL BASELINE, NOT A SEMANTIC MODEL. It finds memories that share words or word pieces with the
// question ("live" ~ "lives", "Mumbai" ~ "Mumbai"), much like a keyword search with fuzzier matching. It does
// NOT know that "flat" and "apartment" mean the same thing. Results obtained with it must say so.
//
// Two features per word: the word itself (weight 1) and its character trigrams with boundary marks
// ("#li", "liv", "ive", "ve#", weight 0.5), so spelling variants and compound words still overlap.
// Signed hashing (one bit of a second hash picks + or -) makes bucket collisions cancel out on average
// instead of always adding up (Weinberger et al., 2009, "Feature hashing for large scale multitask learning").
const DIMS = 256;
const VERSION = 1;
const TRIGRAM_WEIGHT = 0.5;

function features(text) {
  const counts = new Map();
  const add = (feature, weight) => counts.set(feature, (counts.get(feature) || 0) + weight);
  for (const word of tokenize(text)) {
    add(`w:${word}`, 1);
    const padded = `#${word}#`;
    for (let i = 0; i + 3 <= padded.length; i += 1) add(`c:${padded.slice(i, i + 3)}`, TRIGRAM_WEIGHT);
  }
  return counts;
}

function lexicalVector(text) {
  const vector = new Array(DIMS).fill(0);
  for (const [feature, tf] of features(text)) {
    const weight = 1 + Math.log(tf / (feature.startsWith('c:') ? TRIGRAM_WEIGHT : 1));
    const sign = fnv1a(`sign:${feature}`) & 1 ? 1 : -1;
    vector[fnv1a(feature) % DIMS] += sign * weight * (feature.startsWith('c:') ? TRIGRAM_WEIGHT : 1);
  }
  return normalize(vector);
}

class LexicalEmbeddingProvider {
  constructor() {
    this.name = 'lexical';
    this.dims = DIMS;
    this.id = `lexical-hash-v${VERSION}-${DIMS}`;
    this.semantic = false; // a lexical baseline: say so wherever its results are reported
    // The cosine below which a memory with no keyword match is treated as unrelated. Hashed trigrams give
    // unrelated sentences a cosine of about 0.1 to 0.2 (shared letter triples, bucket collisions), so the
    // cut-off sits above that. Chosen by inspecting the seed data, not tuned on any benchmark; Stage 6 should
    // tune it on a development split. RETRIEVAL_MIN_VECTOR overrides it.
    this.minVector = 0.3;
  }

  async embed(texts) {
    return texts.map(lexicalVector);
  }
}

module.exports = { LexicalEmbeddingProvider, lexicalVector, DIMS };
