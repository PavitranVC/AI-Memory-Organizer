const { LlmError } = require('./errors');
const { ollamaConfig } = require('./config');

// Free local models through Ollama's HTTP API (https://github.com/ollama/ollama/blob/main/docs/api.md).
// Selected with LLM_PROVIDER=ollama. Same interface as the Anthropic provider: generateJson() returns
// { data, servedModel, stopReason, usage } and failures are LlmError, so nothing above this file changes.
//  - Structured output: the task's JSON schema is sent as "format", and Ollama constrains the answer to it.
//  - num_ctx: Ollama's context window counts the prompt AND the answer, and anything that does not fit is
//    cut silently. Each call gets the small window (OLLAMA_NUM_CTX) when it fits and the large one
//    (OLLAMA_NUM_CTX_LARGE) only when it must, i.e. the full-context baseline. Only two sizes, because Ollama
//    reloads the model whenever num_ctx changes.
//  - Reasoning models (deepseek-r1) may write <think>...</think> before the JSON: it is removed before parsing.
//  - Tokens are Ollama's own counts (prompt_eval_count, eval_count); the cost is 0 (it runs on your machine).
//  - One retry on a timeout or an answer that is not valid JSON, then the usual LlmError.

// Output cap per task (num_predict). The judge gets more room because a reasoning model thinks first.
const NUM_PREDICT = { extract: 2048, reconcile: 1024, answer: 1024, eval_answer: 1024, judge: 2048 };
// Rough size of the prompt in tokens, only to pick num_ctx. 4 characters per token UNDER-estimated LoCoMo text
// by about 20% on the laptop pilot (qwen2.5's tokenizer, 2026-10-13), which could let Ollama cut a long prompt
// silently; 3.3 errs on the safe side. The margin covers the chat template and the schema.
const CHARS_PER_TOKEN = 3.3;
const MARGIN_TOKENS = 512;
// The retry is not sent at temperature 0, which would repeat the same broken answer word for word
const TEMPERATURES = [0, 0.3];

// POST to Ollama with a timeout. Shared with the embedding provider. Throws an Error with .status (HTTP
// error), .timeout or .unreachable set, so each caller can turn it into its own error type.
async function ollamaPost({ url, path, payload, timeoutMs, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const hint = response.status === 404 ? ` (is the model pulled? run "ollama pull ${payload.model}")` : '';
      throw Object.assign(new Error(`Ollama error ${response.status}: ${detail.slice(0, 200)}${hint}`), { status: response.status });
    }
    return await response.json();
  } catch (err) {
    if (err.status) throw err;
    if (err.name === 'AbortError') throw Object.assign(new Error(`Ollama did not answer within ${timeoutMs} ms`), { timeout: true });
    throw Object.assign(new Error(`Cannot reach Ollama at ${url}: ${err.message} (is Ollama running?)`), { unreachable: true });
  } finally {
    clearTimeout(timer);
  }
}

// The models pulled on the server (GET /api/tags), or null if Ollama does not answer. Used by
// "npm run test:live" to skip cleanly when Ollama is not running.
async function listOllamaModels({ url, timeoutMs = 3000, fetchImpl = globalThis.fetch }) {
  try {
    const response = await fetchImpl(`${url}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = await response.json();
    return (body.models || []).map((m) => m.name);
  } catch (err) {
    return null;
  }
}

// "qwen2.5-coder" means "qwen2.5-coder:latest" to Ollama
const hasModel = (names, wanted) => names.includes(wanted) || (!wanted.includes(':') && names.includes(`${wanted}:latest`));

// Removes a reasoning block. Some model templates open <think> in the prompt, so the answer may hold only
// the closing tag: everything up to it is reasoning too.
function stripThinking(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim();
}

function parseJson(text) {
  const clean = stripThinking(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

// The smallest of the two windows that holds the prompt plus the answer, or null if neither does
function contextSize(promptChars, numPredict, { numCtx, numCtxLarge }) {
  const needed = Math.ceil(promptChars / CHARS_PER_TOKEN) + numPredict + MARGIN_TOKENS;
  if (needed <= numCtx) return numCtx;
  if (needed <= numCtxLarge) return numCtxLarge;
  return null;
}

class OllamaProvider {
  constructor({ config = ollamaConfig(), fetchImpl = globalThis.fetch } = {}) {
    this.name = 'ollama';
    this.local = true; // runs on the user's machine: every call costs $0
    this.config = config;
    this.fetch = fetchImpl; // tests pass a fake fetch, so CI never needs Ollama
  }

  buildRequest({ model, system, userPrefix = null, user, schema, numCtx, numPredict, temperature = 0 }) {
    return {
      model,
      stream: false,
      format: schema,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrefix ? `${userPrefix}\n\n${user}` : user },
      ],
      options: { num_ctx: numCtx, num_predict: numPredict, temperature },
    };
  }

  async generateJson({ task, model, system, userPrefix = null, user, schema, maxTokens = 4000 }) {
    const numPredict = Math.min(maxTokens, NUM_PREDICT[task] || 1024);
    const promptChars = system.length + (userPrefix ? userPrefix.length : 0) + user.length;
    const numCtx = contextSize(promptChars, numPredict, this.config);
    if (!numCtx) {
      throw new LlmError(`The prompt (~${Math.ceil(promptChars / CHARS_PER_TOKEN)} tokens) does not fit in OLLAMA_NUM_CTX_LARGE=${this.config.numCtxLarge}`, { retryable: false });
    }
    // Tokens of every attempt are added up: a failed attempt still used the GPU
    const result = { servedModel: model, stopReason: null, attempts: 0, numCtx, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    let lastError = null;
    for (let attempt = 1; attempt <= TEMPERATURES.length; attempt += 1) {
      result.attempts = attempt;
      const request = this.buildRequest({ model, system, userPrefix, user, schema, numCtx, numPredict, temperature: TEMPERATURES[attempt - 1] });
      let body;
      try {
        body = await ollamaPost({ url: this.config.url, path: '/api/chat', payload: request, timeoutMs: this.config.timeoutMs, fetchImpl: this.fetch });
      } catch (err) {
        // 4xx (e.g. a model that is not pulled) will not fix itself; 5xx, timeouts and a stopped server might
        lastError = new LlmError(err.message, { retryable: !(err.status >= 400 && err.status < 500) });
        if (err.timeout) continue;
        break;
      }
      result.usage.inputTokens += body.prompt_eval_count || 0;
      result.usage.outputTokens += body.eval_count || 0;
      result.servedModel = body.model || model;
      result.stopReason = body.done_reason || null;
      try {
        result.data = parseJson((body.message && body.message.content) || '');
        return result;
      } catch (err) {
        const cut = body.done_reason === 'length';
        lastError = new LlmError(cut ? `The answer was cut off at num_predict (${numPredict})` : `The answer was not valid JSON: ${err.message}`, { stopReason: cut ? 'max_tokens' : result.stopReason });
      }
    }
    throw Object.assign(lastError, { result });
  }
}

module.exports = { OllamaProvider, ollamaPost, listOllamaModels, hasModel, stripThinking, parseJson, contextSize, NUM_PREDICT };
