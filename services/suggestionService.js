const Suggestion = require('../models/Suggestion');
const memoryService = require('./memoryService');
const { notFound } = require('./errors');
const { toObjectId } = require('./ids');
const { paginate } = require('./pagination');

// Stage 7: facts waiting for the user's decision (categories set to "ask"), newest first
async function listSuggestions(userId, query) {
  const { items, limit, nextCursor } = await paginate(Suggestion, { userId }, query, { populate: [{ path: 'categoryId', select: 'name' }] });
  return { count: items.length, limit, nextCursor, suggestions: items };
}

// Accepting turns the suggestion into a memory (an ADD through memoryService, so versioning, the audit log and
// the "never" check all apply). The suggestion is claimed (deleted) first, so two concurrent accepts cannot
// both create a memory; if creating fails, it is put back.
// Accepting does not run reconciliation (that needs an LLM call, and the API never waits for the LLM), so an
// accepted fact is always added as a new memory, even if a similar one exists.
async function acceptSuggestion(userId, id) {
  const suggestion = await Suggestion.findOneAndDelete({ _id: toObjectId(id), userId }).lean();
  if (!suggestion) throw notFound('Suggestion not found');
  try {
    return await memoryService.createMemory(userId, {
      categoryId: String(suggestion.categoryId),
      conversationId: String(suggestion.conversationId),
      content: suggestion.content,
      tags: suggestion.topic ? [suggestion.topic] : [],
      importance: suggestion.importance,
      confidence: suggestion.confidence,
      sensitivity: suggestion.sensitivity,
      sourceMessageIds: [String(suggestion.messageId)],
      validFrom: suggestion.validFrom,
    });
  } catch (err) {
    await Suggestion.create(suggestion).catch(() => {});
    throw err;
  }
}

async function rejectSuggestion(userId, id) {
  const suggestion = await Suggestion.findOneAndDelete({ _id: toObjectId(id), userId });
  if (!suggestion) throw notFound('Suggestion not found');
  return suggestion;
}

module.exports = { listSuggestions, acceptSuggestion, rejectSuggestion };
