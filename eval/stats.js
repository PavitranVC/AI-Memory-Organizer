const { createRng } = require('../services/datasets/common');

// Small statistics helpers for the Stage 6 results. No library: each one is a few lines and testable.

// Nearest-rank percentile: the smallest value with at least p% of the samples at or below it
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const mean = (values) => (values.length === 0 ? null : values.reduce((s, x) => s + x, 0) / values.length);
const round = (x, digits = 2) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10 ** digits) / 10 ** digits);

function summary(values) {
  return { n: values.length, p50: round(percentile(values, 50)), p95: round(percentile(values, 95)), mean: round(mean(values)) };
}

// PAIRED BOOTSTRAP confidence interval for the difference in mean score between two systems answering the
// SAME questions (Efron & Tibshirani, 1993). a[i] and b[i] are the two systems' scores on question i.
// Each resample draws n questions with replacement and recomputes mean(a) - mean(b); the 2.5th and 97.5th
// percentiles of those differences give the 95% interval (the "percentile method"). Pairing matters: both
// systems are resampled on the same questions, so question difficulty cancels out.
// Seeded, so the same scores always give the same interval.
function pairedBootstrap(a, b, { resamples = 2000, seed = 1, level = 0.95 } = {}) {
  if (a.length !== b.length) throw new Error('paired bootstrap needs two score lists of the same length');
  const n = a.length;
  if (n === 0) return { n: 0, diff: null, low: null, high: null, resamples };
  const diffs = a.map((x, i) => x - b[i]);
  const rng = createRng(seed);
  const stats = [];
  for (let r = 0; r < resamples; r += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += diffs[rng.int(0, n - 1)];
    stats.push(sum / n);
  }
  const tail = ((1 - level) / 2) * 100;
  return { n, diff: mean(diffs), low: percentile(stats, tail), high: percentile(stats, 100 - tail), resamples };
}

// Bootstrap 95% interval for ONE system's mean score (percentile method, seeded): the whisker on the charts
function bootstrapMean(values, { resamples = 2000, seed = 1, level = 0.95 } = {}) {
  const n = values.length;
  if (n === 0) return { n: 0, mean: null, low: null, high: null, resamples };
  const rng = createRng(seed);
  const stats = [];
  for (let r = 0; r < resamples; r += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += values[rng.int(0, n - 1)];
    stats.push(sum / n);
  }
  const tail = ((1 - level) / 2) * 100;
  return { n, mean: mean(values), low: percentile(stats, tail), high: percentile(stats, 100 - tail), resamples };
}

module.exports = { percentile, mean, round, summary, pairedBootstrap, bootstrapMean };
