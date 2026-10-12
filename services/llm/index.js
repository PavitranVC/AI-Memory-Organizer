const LlmCall = require('../../models/LlmCall');
const { llmConfig } = require('./config');
const { loadPrompt, render } = require('./prompts');
const { costUsd } = require('./pricing');
const { MockProvider } = require('./mockProvider');
const { AnthropicProvider } = require('./anthropicProvider');
const { LlmError, LlmRefusalError } = require('./errors');
const { EXTRACT_SCHEMA, RECONCILE_SCHEMA } = require('./schemas');

// Every LLM call in the project goes through callLlm(): it picks the provider from LLM_PROVIDER, fills the
// versioned prompt, and logs the call (tokens, cache reads, latency, cost) to the llmcalls collection.
const TASKS = {
  extract: { schema: EXTRACT_SCHEMA, maxTokens: 8000 },
  reconcile: { schema: RECONCILE_SCHEMA, maxTokens: 4000 },
};

let override = null; // a provider set by tests or scripts (setProvider), instead of the one from the env

function getProvider(config = llmConfig()) {
  if (override) return override;
  return config.provider === 'anthropic' ? new AnthropicProvider({ config }) : new MockProvider();
}

function setProvider(provider) {
  override = provider;
}

// vars: the template variables (strings) for the "## User" section. extra: structured copies the mock reads.
async function callLlm({ task, vars, extra = {}, userId = null, jobId = null }) {
  const spec = TASKS[task];
  if (!spec) throw new Error(`Unknown LLM task "${task}"`);
  const config = llmConfig();
  const provider = getProvider(config);
  const prompt = loadPrompt(task);
  const model = config.models[task];
  const user = render(prompt.userTemplate, vars);

  const started = Date.now();
  let outcome;
  let error = null;
  try {
    outcome = await provider.generateJson({ task, model, system: prompt.system, user, schema: spec.schema, maxTokens: spec.maxTokens, vars: extra });
  } catch (err) {
    error = err instanceof LlmError ? err : new LlmError(err.message);
    outcome = err.result || null; // a refusal or a cut-off answer still used (and billed) tokens
  }
  const latencyMs = Date.now() - started;

  const usage = (outcome && outcome.usage) || {};
  const servedModel = (outcome && outcome.servedModel) || null;
  const estimated = provider.name === 'mock';
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
    costUsd: estimated ? 0 : costUsd(servedModel || model, usage),
  });

  if (error) throw error;
  return outcome.data;
}

module.exports = { callLlm, getProvider, setProvider, TASKS };
