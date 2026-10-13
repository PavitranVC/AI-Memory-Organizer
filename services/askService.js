const { badRequest, HttpError } = require('./errors');
const { retrieve } = require('./retrieval');
const { callLlm } = require('./llm');
const { LlmError } = require('./llm/errors');
const { validateAnswer } = require('./llm/schemas');

// POST /api/ask: retrieval-augmented answering (RAG) over the user's own memories.
//   1. Hybrid retrieval (services/retrieval) finds the top-k memories valid at asOf (default now).
//   2. Only those k memories go to the answer model (never the whole store: cost grows with input tokens).
//   3. The answer cites memories by label; labels are checked and mapped back to memory ids, so every
//      citation is a memory of this user that was valid at asOf.
const MAX_QUESTION = 1000;
const NO_MEMORIES = "I don't have any memories that answer this question.";

const day = (date) => (date ? date.toISOString().slice(0, 10) : null);

async function ask(userId, body = {}) {
  const { question } = body;
  if (typeof question !== 'string' || question.trim() === '') throw badRequest('"question" is required, e.g. {"question": "Where do I live?"}');
  if (question.length > MAX_QUESTION) throw badRequest(`"question" can be at most ${MAX_QUESTION} characters`);
  if (body.asOf !== undefined && typeof body.asOf !== 'string') throw badRequest('asOf must be an ISO date string, e.g. 2025-03-01');

  const retrieval = await retrieve(userId, { query: question, asOf: body.asOf, k: body.k });
  const at = retrieval.asOf || new Date();
  const shown = retrieval.results.map((r, i) => ({
    label: `m${i + 1}`,
    content: r.memory.content,
    category: r.memory.categoryId ? r.memory.categoryId.name : null,
    validFrom: day(r.memory.validFrom),
    // A version closed AFTER the question date was still true on that date
    validTo: r.memory.validTo && r.memory.validTo <= at ? day(r.memory.validTo) : null,
    importance: r.memory.importance,
  }));
  const memories = retrieval.results.map((r, i) => ({ label: shown[i].label, id: r.memory._id, content: r.memory.content, validFrom: r.memory.validFrom, validTo: r.memory.validTo, score: r.score, components: r.components }));
  const base = { question: question.trim(), asOf: retrieval.asOf, k: retrieval.k, embeddingModel: retrieval.embeddingModel, warnings: retrieval.warnings };

  // Nothing relevant was found: say so without paying for an LLM call
  if (shown.length === 0) return { ...base, answer: NO_MEMORIES, insufficient: true, citedMemoryIds: [], citations: [], memories, llmCalled: false };

  let result;
  try {
    const data = await callLlm({
      task: 'answer',
      vars: { asOf: day(at), memories: JSON.stringify(shown, null, 1), question: question.trim() },
      extra: { question: question.trim(), memories: shown },
      userId,
    });
    result = validateAnswer(data, shown.map((m) => m.label));
  } catch (err) {
    // The model failed or broke the contract: a gateway error, not the client's fault
    throw new HttpError(502, `The answer model failed: ${err instanceof LlmError ? err.message : `invalid answer (${err.message})`}`);
  }
  const cited = memories.filter((m) => result.citedMemories.includes(m.label));
  return {
    ...base,
    answer: result.answer,
    insufficient: result.insufficient,
    citedMemoryIds: cited.map((m) => m.id),
    citations: cited.map(({ label, id, content, validFrom, validTo }) => ({ label, id, content, validFrom, validTo })),
    memories,
    llmCalled: true,
  };
}

module.exports = { ask, MAX_QUESTION };
