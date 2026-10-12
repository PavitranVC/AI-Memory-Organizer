// US dollars per million tokens, from Anthropic's published price list (checked 2026-10-12).
// Cache writes use the 5-minute TTL (1.25 x input); cache reads are billed separately at the listed rate.
// Prices change: check https://www.anthropic.com/pricing before relying on a cost figure.
const PRICES = {
  'claude-opus-5-5': { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
};

// Cost of one call. Returns null when the model has no price here (so a missing price is never shown as $0).
function costUsd(model, { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 } = {}) {
  const price = PRICES[model];
  if (!price) return null;
  const total =
    inputTokens * price.input + outputTokens * price.output + cacheReadTokens * price.cacheRead + cacheWriteTokens * price.cacheWrite;
  return total / 1e6;
}

module.exports = { PRICES, costUsd };
