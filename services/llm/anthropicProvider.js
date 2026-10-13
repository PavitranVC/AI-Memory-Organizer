const { LlmError, LlmRefusalError } = require('./errors');

// Claude through the official SDK (@anthropic-ai/sdk).
//  - Structured outputs (output_config.format = json_schema): the API constrains the answer to the schema.
//  - Prompt caching: the system prompt is identical on every call of a task and carries cache_control, so
//    after the first call it is read from the cache (usage.cache_read_input_tokens) at a fraction of the price.
//    The model only caches a prefix of at least 512 tokens, which the prompts in prompts/ are written to pass.
//  - Refusals: a safety classifier can decline (stop_reason "refusal"). With LLM_FALLBACKS=default (the
//    default) the API re-runs the request on a fallback model first; if the answer is still a refusal it is
//    reported as LlmRefusalError, which is not retried.
// Thinking is always on for Claude Opus 5.5 (adaptive); its depth is set with LLM_EFFORT.
class AnthropicProvider {
  constructor({ client, config } = {}) {
    this.name = 'anthropic';
    this.config = config;
    if (client) {
      this.client = client; // tests inject a fake client, so no network call is ever made in CI
    } else {
      if (!process.env.ANTHROPIC_API_KEY) throw new LlmError('LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY', { retryable: false });
      const Anthropic = require('@anthropic-ai/sdk');
      this.client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
    }
  }

  // userPrefix (optional): stable text that starts the user turn (Stage 6: the conversation in the full-context
  // baseline). It gets its own cache breakpoint, so repeated questions about one conversation read it from the
  // cache; only the text after it (the question) is billed at the full input price.
  buildRequest({ model, system, userPrefix = null, user, schema, maxTokens }) {
    const request = {
      model,
      max_tokens: maxTokens,
      // Stable text first and cached; the per-call text comes after it, in the user turn
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: userPrefix ? [{ type: 'text', text: userPrefix, cache_control: { type: 'ephemeral' } }, { type: 'text', text: user }] : user,
        },
      ],
      output_config: { effort: this.config.effort, format: { type: 'json_schema', schema } },
    };
    if (this.config.fallbacks) {
      request.betas = ['server-side-fallback-2026-07-01'];
      request.fallbacks = this.config.fallbacks;
    }
    return request;
  }

  async generateJson({ model, system, userPrefix = null, user, schema, maxTokens = 8000 }) {
    const request = this.buildRequest({ model, system, userPrefix, user, schema, maxTokens });
    const api = this.config.fallbacks ? this.client.beta.messages : this.client.messages;
    let response;
    try {
      response = await api.create(request);
    } catch (err) {
      // 4xx other than 408/409/429 means the request itself is wrong (bad key, bad parameter): do not retry
      const status = err && err.status;
      const retryable = !status || status === 408 || status === 409 || status === 429 || status >= 500;
      throw new LlmError(`Anthropic API error${status ? ` ${status}` : ''}: ${err.message}`, { retryable });
    }

    const usage = response.usage || {};
    const result = {
      servedModel: response.model || model,
      stopReason: response.stop_reason,
      usage: {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        cacheWriteTokens: usage.cache_creation_input_tokens || 0,
      },
    };

    // Always check stop_reason before reading the content
    if (response.stop_reason === 'refusal') {
      const details = response.stop_details || {};
      throw Object.assign(new LlmRefusalError(`The model declined the request${details.category ? ` (${details.category})` : ''}`, { category: details.category || null }), { result });
    }
    if (response.stop_reason === 'max_tokens') {
      throw Object.assign(new LlmError(`The answer was cut off at max_tokens (${maxTokens})`, { stopReason: 'max_tokens' }), { result });
    }
    const text = (response.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
    try {
      result.data = JSON.parse(text);
    } catch (err) {
      throw Object.assign(new LlmError(`The answer was not valid JSON: ${err.message}`), { result });
    }
    return result;
  }
}

module.exports = { AnthropicProvider };
