const User = require('../models/User');
const Category = require('../models/Category');
const Consent = require('../models/Consent');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Memory = require('../models/Memory');
const AuditLog = require('../models/AuditLog');
const Job = require('../models/Job');
const LlmCall = require('../models/LlmCall');
const EvalItem = require('../models/EvalItem');
const Suggestion = require('../models/Suggestion');

const FORMAT = 'ai-memory-organizer-export/v1';

// Stage 7: everything stored about one user, as one JSON document (GDPR Art. 15 access and Art. 20
// portability; DPDP Act s.11). Every collection that holds rows about a user is listed here; the export
// test fails if a new model is added without being exported.
// Categories are shared reference data, not the user's own: only the ones the user's data points at are
// included, by name, so the export can be read on its own.
// Embedding vectors are derived from the memory text (hundreds of numbers each); they are included only with
// ?embeddings=true, and the export says so when they are left out.
async function exportUserData(userId, { embeddings = false } = {}) {
  const user = await User.findById(userId).lean();
  const byId = { _id: 1 };
  const conversations = await Conversation.find({ userId }).sort(byId).lean();
  const conversationIds = conversations.map((c) => c._id);
  const memoryQuery = Memory.find({ userId }).sort(byId);
  if (embeddings) memoryQuery.select('+embedding');

  const [consents, messages, memories, auditlog, jobs, llmcalls, evalitems, suggestions] = await Promise.all([
    Consent.find({ userId }).sort(byId).lean(),
    Message.find({ conversationId: { $in: conversationIds } }).sort({ conversationId: 1, sentAt: 1, _id: 1 }).lean(),
    memoryQuery.lean(),
    AuditLog.find({ userId }).sort(byId).lean(),
    Job.find({ userId }).sort(byId).lean(),
    LlmCall.find({ userId }).sort(byId).lean(),
    EvalItem.find({ userId }).sort(byId).lean(),
    Suggestion.find({ userId }).sort(byId).lean(),
  ]);
  const categoryIds = [...new Set([...memories, ...consents, ...suggestions].map((r) => String(r.categoryId)))];
  const categories = await Category.find({ _id: { $in: categoryIds } }).select('name description').sort(byId).lean();
  if (user) delete user.passwordHash; // never selected anyway (select: false); a hash is a credential, not data about the person

  const data = { user, consents, conversations, messages, memories, auditlog, jobs, llmcalls, evalitems, suggestions, categories };
  return {
    format: FORMAT,
    exportedAt: new Date(),
    userId,
    counts: Object.fromEntries(Object.entries(data).map(([key, rows]) => [key, Array.isArray(rows) ? rows.length : rows ? 1 : 0])),
    omitted: [
      'passwordHash: a credential, not information about you',
      ...(embeddings ? [] : ['memories.embedding: derived vectors of the memory text; add ?embeddings=true to include them']),
    ],
    ...data,
  };
}

module.exports = { FORMAT, exportUserData };
