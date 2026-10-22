// Answer scoring for the Stage 6 evaluation.
//
// 1. Token F1 (the SQuAD-style QA metric, Rajpurkar et al., 2016): lower-case, drop punctuation, the
//    articles a/an/the and the word "and" (as we read LoCoMo's code does), split into words, then F1 of the word overlap between prediction and gold answer.
// 2. locomoScore: token F1 with the per-category rules of the LoCoMo paper's QA evaluation, as we read them:
//      multi-hop (1):   the gold answer lists several parts separated by commas; each part is matched with its
//                       best part of the prediction and the F1s are averaged
//      open-domain (3): only the part of the gold answer before the first ";" is used
//      adversarial (5): 1 if the prediction says the information is not available, else 0
//    TODO: verify against the authors' evaluation code (it also applies Porter stemming, which we do not).
//    So our F1 is "LoCoMo-style", not guaranteed identical to the published numbers.
// 3. Retrieval recall@k: the share of the question's evidence turns that the context sent to the model
//    contains (for memories, through their provenance: the source messages of each memory).
const ABSTAIN = /\b(no information available|not mentioned|no information|not available|cannot be determined|does not say|doesn't say)\b/i;

function normalizeAnswer(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(a|an|the|and)\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function tokenF1(prediction, gold) {
  const p = normalizeAnswer(prediction);
  const g = normalizeAnswer(gold);
  if (p.length === 0 || g.length === 0) return p.length === g.length ? 1 : 0;
  const counts = new Map();
  for (const w of g) counts.set(w, (counts.get(w) || 0) + 1);
  let common = 0;
  for (const w of p) {
    if (counts.get(w) > 0) {
      common += 1;
      counts.set(w, counts.get(w) - 1);
    }
  }
  if (common === 0) return 0;
  const precision = common / p.length;
  const recall = common / g.length;
  return (2 * precision * recall) / (precision + recall);
}

const abstains = (prediction) => ABSTAIN.test(String(prediction || ''));

// item: { category, answer } as stored in evalitems (LoCoMo's own category numbers)
function locomoScore(prediction, item) {
  if (item.category === 5) return abstains(prediction) ? 1 : 0;
  let gold = String(item.answer === null || item.answer === undefined ? '' : item.answer);
  if (item.category === 3) gold = gold.split(';')[0];
  if (item.category === 1) {
    const goldParts = gold.split(',').map((s) => s.trim()).filter(Boolean);
    const predParts = String(prediction || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (goldParts.length === 0) return 0;
    const best = goldParts.map((g) => Math.max(0, ...predParts.map((p) => tokenF1(p, g))));
    return best.reduce((s, x) => s + x, 0) / best.length;
  }
  return tokenF1(prediction, gold);
}

// LongMemEval: its questions have free-form gold answers and no numeric LoCoMo categories, so none of the
// category rules above apply. An abstention question (the history does not contain the answer) is right only when
// the prediction says so; every other question is plain token F1. The headline number for LongMemEval is the
// judge verdict, as in the benchmark; this F1 is only a cheap second view.
function longmemevalScore(prediction, item) {
  if (item.abstention) return abstains(prediction) ? 1 : 0;
  return tokenF1(prediction, String(item.answer === null || item.answer === undefined ? '' : item.answer));
}

// evidence: the question's evidence dialog ids; covered: the dialog ids present in the context.
// null when the question has no evidence (it cannot be scored).
function recallAtK(evidence, covered) {
  const wanted = [...new Set(evidence)];
  if (wanted.length === 0) return null;
  const have = new Set(covered);
  return wanted.filter((id) => have.has(id)).length / wanted.length;
}

module.exports = { normalizeAnswer, tokenF1, locomoScore, longmemevalScore, recallAtK, abstains };
