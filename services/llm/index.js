const LlmCall = require('../../models/LlmCall');
const { llmConfig } = require('./config');
const { loadPrompt, render } = require('./prompts');
const { costUsd } = require('./pricing');
const { MockProvider } = require('./mockProvider');
const { AnthropicProvider } = require('./anthropicProvider');
const { LlmError, LlmRefusalError } = require('./errors');
const { EXTRACT_SCHEMA, RECONCILE_SCHEMA, ANSWER_SCHEMA, JUDGE_SCHEMA } = require('./schemas');

// Every LLM call in the project goes through callLlm(): it picks the provider from LLM_PROVIDER, fills the
// versioned prompt, and logs the call (tokens, cache reads, latency, cost) to the llmcalls collection.
const TASKS = {
  extract: { schema: EXTRACT_SCHEMA, maxTokens: 8000 },
  reconcile: { schema: RECONCILE_SCHEMA, maxTokens: 4000 },
  answer: { schema: ANSWER_SCHEMA, maxTokens: 4000 }, // Stage 4: POST /api/ask
  // Stage 6 evaluation: one answer prompt for every compared system (same model as /api/ask), and the judge
  eval_answer: { schema: ANSWER_SCHEMA, maxTokens: 4000, model: 'answer' },
  judge: { schema: JUDGE_SCHEMA, maxTokens: 2000 },
};

// A prompt's user part may contain this marker: the text before it is the same on many calls (e.g. the whole
// conversation in the full-context baseline), so the provider caches it as well as the system part.
const CACHE_BREAK = '<!-- cache-break -->';

let override = null; // a provider set by tests or scripts (setProvider), instead of the one from the env

function getProvider(config = llmConfig()) {
  if (override) return override;
  return config.provider === 'anthropic' ? new AnthropicProvider({ config }) : new MockProvider();
}

function setProvider(provider) {
  override = provider;
}

// vars: the template variables (strings) for the "## User" section. extra: structured copies the mock reads.
// Returns the model's data plus what the call cost (the Stage 6 harness reports tokens and cost per question).
// cachePrefix: cache the user text before the cache-break marker too. Only worth it when that text repeats
// (a cache write costs 1.25x the input price), so it is off unless the caller asks.
async function callLlmDetailed({ task, vars, extra = {}, userId = null, jobId = null, cachePrefix = false }) {
  const spec = TASKS[task];
  if (!spec) throw new Error(`Unknown LLM task "${task}"`);
  const config = llmConfig();
  const provider = getProvider(config);
  const prompt = loadPrompt(task);
  const model = config.models[spec.model || task];
  const rendered = render(prompt.userTemplate, vars);
  const cut = rendered.indexOf(CACHE_BREAK);
  const userPrefix = cut >= 0 && cachePrefix ? rendered.slice(0, cut).trim() : null;
  const user = userPrefix !== null ? rendered.slice(cut + CACHE_BREAK.length).trim() : rendered.replace(CACHE_BREAK, '');

  const started = Date.now();
  let outcome;
  let error = null;
  try {
    outcome = await provider.generateJson({ task, model, system: prompt.system, userPrefix, user, schema: spec.schema, maxTokens: spec.maxTokens, vars: extra });
  } catch (err) {
    error = err instanceof LlmError ? err : new LlmError(err.message);
    outcome = err.result || null; // a refusal or a cut-off answer still used (and billed) tokens
  }
  const latencyMs = Date.now() - started;

  const usage = (outcome && outcome.usage) || {};
  const servedModel = (outcome && outcome.servedModel) || null;
  const estimated = provider.name === 'mock';
  const cost = estimated ? 0 : costUsd(servedModel || model, usage);
  await LlmCall.create({
    userId,
    jobId,
    task,
    provider: provider.name,
    model,
    servedModel,
    promptId: prompt.id,
    promptHash: prompt.hash,
    status: error ? (error instanceof LlmRefusalError ? 'refusal' : 'error') : 'ok',
    stopReason: error ? error.stopReason : outcome.stopReason,
    error: error ? error.message.slice(0, 500) : null,
    ...usage,
    tokensEstimated: estimated,
    latencyMs,
    costUsd: cost,
  });

  if (error) throw error;
  return { data: outcome.data, provider: provider.name, model: servedModel || model, promptId: prompt.id, usage, tokensEstimated: estimated, costUsd: cost, latencyMs };
}

async function callLlm(args) {
  return (await callLlmDetailed(args)).data;
}

module.exports = { callLlm, callLlmDetailed, getProvider, setProvider, TASKS, CACHE_BREAK };
