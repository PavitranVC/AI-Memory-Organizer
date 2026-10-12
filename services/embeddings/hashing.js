// Shared helpers for the two offline embedders (mock and lexical). Both use FEATURE HASHING (the "hashing
// trick"): each token is hashed to one of N buckets, so any vocabulary fits in a fixed-size vector without
// storing a dictionary. Similar texts share tokens, so their vectors point in similar directions.
// This captures shared WORDS only, not meaning: "flat" and "apartment" stay unrelated.

// A small English stop-word list: words that say nothing about the topic of a sentence
const STOP_WORDS = new Set(
  ('a an the and or but if of in on at to for from by with about as into is am are was were be been being do does did ' +
    'i me my mine we our you your he him his she her it its they them their this that these those what which who whom ' +
    'where when why how there here not no so too very can could will would shall should may might must have has had ' +
    'just also than then now any some all each both such only own same up down out over under again once').split(' ')
);

// 32-bit FNV-1a hash: fast, deterministic and well spread, which is all feature hashing needs
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// A crude suffix stripper so "lives", "living" and "lived" share the token "liv"/"live". Not a real stemmer.
function stem(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -1);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// Lowercase words without punctuation or stop words, stemmed
function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP_WORDS.has(w))
    .map(stem);
}

// Scales a vector to length 1, so cosine similarity becomes a plain dot product. An all-zero vector (a text
// with no usable tokens) stays zero.
function normalize(vector) {
  const length = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return length === 0 ? vector : vector.map((x) => x / length);
}

// Cosine similarity: the cosine of the angle between two vectors, from -1 (opposite) to 1 (same direction).
// 0 when either vector is all zeros or the lengths differ (vectors from different models are not comparable).
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

module.exports = { STOP_WORDS, fnv1a, stem, tokenize, normalize, cosine };
