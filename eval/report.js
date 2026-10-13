// Turns the per-question rows of an evaluation run into the summary tables (CSV rows). Pure functions, so
// the tests can check them and the numbers in docs/RESULTS.md can be traced to one place.
const { mean, round, summary, pairedBootstrap, bootstrapMean } = require('./stats');
const { createRng } = require('../services/datasets/common');

const BASELINE = 'ours';
const total = (r) => (r.retrieval_ms || 0) + (r.answer_ms || 0);
const cost = (r) => (r.answer_cost_usd === undefined ? null : r.answer_cost_usd); // null: the model has no price

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) || []), r]);
  return out;
}

// One row per system (and, in byType, per system x question type)
function systemRow(system, rows, extra = {}) {
  const f1 = rows.map((r) => r.score_f1);
  const judge = rows.map((r) => r.judge_correct);
  const recall = rows.map((r) => r.recall_at_k).filter((x) => x !== null && x !== undefined);
  const f1ci = bootstrapMean(f1);
  const jci = bootstrapMean(judge);
  const lat = summary(rows.map(total));
  const costs = rows.map(cost);
  return {
    system,
    ...extra,
    n: rows.length,
    score_f1_mean: round(f1ci.mean, 4),
    score_f1_ci_low: round(f1ci.low, 4),
    score_f1_ci_high: round(f1ci.high, 4),
    judge_accuracy: round(jci.mean, 4),
    judge_ci_low: round(jci.low, 4),
    judge_ci_high: round(jci.high, 4),
    recall_at_k_mean: recall.length ? round(mean(recall), 4) : null,
    recall_n: recall.length,
    abstained: rows.filter((r) => r.insufficient).length,
    latency_p50_ms: lat.p50,
    latency_p95_ms: lat.p95,
    retrieval_p50_ms: summary(rows.map((r) => r.retrieval_ms || 0)).p50,
    mean_context_tokens_est: round(mean(rows.map((r) => r.context_tokens_est)), 0),
    mean_input_tokens: round(mean(rows.map((r) => r.input_tokens)), 0),
    mean_output_tokens: round(mean(rows.map((r) => r.output_tokens)), 0),
    mean_cache_read_tokens: round(mean(rows.map((r) => r.cache_read_tokens)), 0),
    tokens_estimated: rows.some((r) => r.tokens_estimated) ? 'yes' : 'no',
    answer_cost_per_question_usd: costs.some((c) => c === null) ? null : round(mean(costs), 6),
  };
}

function bySystem(rows, order) {
  const groups = groupBy(rows, (r) => r.system);
  return order.filter((s) => groups.has(s)).map((s) => systemRow(s, groups.get(s)));
}

function byType(rows, order) {
  const out = [];
  const groups = groupBy(rows, (r) => r.system);
  for (const s of order.filter((x) => groups.has(x))) {
    const types = groupBy(groups.get(s), (r) => r.question_type);
    for (const t of [...types.keys()].sort()) out.push(systemRow(s, types.get(t), { question_type: t }));
  }
  return out;
}

// Paired bootstrap of ours minus each other system, on the questions both answered (same question order)
function versusOurs(rows) {
  const key = (r) => `${r.sample}|${r.qa_index}`;
  const ours = new Map(rows.filter((r) => r.system === BASELINE).map((r) => [key(r), r]));
  if (ours.size === 0) return [];
  const out = [];
  const others = [...new Set(rows.map((r) => r.system))].filter((s) => s !== BASELINE);
  for (const other of others) {
    const pairs = rows.filter((r) => r.system === other && ours.has(key(r))).map((r) => [ours.get(key(r)), r]);
    for (const metric of ['judge_correct', 'score_f1']) {
      const b = pairedBootstrap(pairs.map(([o]) => o[metric]), pairs.map(([, x]) => x[metric]));
      const significant = b.n > 0 && (b.low > 0 || b.high < 0);
      out.push({ comparison: `${BASELINE} - ${other}`, metric, n: b.n, diff: round(b.diff, 4), ci_low: round(b.low, 4), ci_high: round(b.high, 4), resamples: b.resamples, interval_excludes_0: significant ? 'yes' : 'no' });
    }
  }
  return out;
}

// A seeded sample of answers for a human to label, to check the judge. The labelling file shows neither the
// system nor the judge's verdict (so neither can bias the label); the key file links them by row_id.
function judgeValidation(rows, n = 50, seed = 11) {
  const rng = createRng(seed);
  const pool = rows.map((r, i) => ({ r, i }));
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, n);
  return {
    toLabel: picked.map(({ r }, idx) => ({ row_id: idx + 1, question: r.question, gold: r.gold, candidate: r.answer, human_correct: '' })),
    key: picked.map(({ r, i }, idx) => ({ row_id: idx + 1, raw_row: i, sample: r.sample, qa_index: r.qa_index, system: r.system, judge_correct: r.judge_correct })),
  };
}

module.exports = { bySystem, byType, versusOurs, judgeValidation, BASELINE };
