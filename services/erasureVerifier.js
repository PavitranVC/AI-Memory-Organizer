const Memory = require('../models/Memory');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const AuditLog = require('../models/AuditLog');
const Suggestion = require('../models/Suggestion');
const Job = require('../models/Job');
const EvalItem = require('../models/EvalItem');
const { toObjectId } = require('./ids');

// Stage 7: proves an erasure left nothing behind. MongoDB has no foreign keys, so "nothing derived remains"
// is checked as a set of anti-joins ($lookup that finds NO match): every reference that could carry data
// derived from a message must point at something that still exists. Scoped to one user, or the whole database.
// Optional extra checks for a specific erasure: the erased message ids are referenced nowhere, and a phrase
// from the erased text appears nowhere.

const EXAMPLES = 5;

// Distinct values at `path` (a field or an array) that have no matching _id in Target
async function dangling(Model, match, path, Target) {
  const rows = await Model.aggregate([
    { $match: { ...match, [path]: { $exists: true, $ne: null } } },
    { $project: { ref: `$${path}` } },
    { $unwind: '$ref' },
    { $group: { _id: '$ref' } },
    { $lookup: { from: Target.collection.name, localField: '_id', foreignField: '_id', as: 'hit' } },
    { $match: { hit: { $size: 0 } } },
    { $project: { _id: 1 } },
  ]).allowDiskUse(true);
  return rows.map((r) => r._id);
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function verifyErasure({ userId = null, messageIds = [], text = null } = {}) {
  const scope = userId ? { userId: toObjectId(String(userId), 'userId') } : {};
  const checks = [];
  const add = (check, found) => checks.push({ check, ok: found.length === 0, violations: found.length, examples: found.slice(0, EXAMPLES).map(String) });

  // 1) Lineage and links of every memory version
  add('memories.sourceMessageIds -> existing messages', await dangling(Memory, scope, 'sourceMessageIds', Message));
  add('memories.conversationId -> existing conversations', await dangling(Memory, scope, 'conversationId', Conversation));
  add('memories.supersedes -> existing versions', await dangling(Memory, scope, 'supersedes', Memory));
  add('memories.supersededBy -> existing versions', await dangling(Memory, scope, 'supersededBy', Memory));
  // 2) The audit log keeps content only about versions that still exist (erased ones are tombstoned)
  const withContent = { ...scope, tombstonedAt: null, $or: [{ before: { $ne: null } }, { after: { $ne: null } }] };
  add('auditlog entries with content -> existing versions (memoryId)', await dangling(AuditLog, withContent, 'memoryId', Memory));
  add('auditlog snapshots -> existing versions (before._id)', await dangling(AuditLog, withContent, 'before._id', Memory));
  add('auditlog snapshots -> existing versions (after._id)', await dangling(AuditLog, withContent, 'after._id', Memory));
  // 3) Everything else derived from messages
  add('suggestions.messageId -> existing messages', await dangling(Suggestion, scope, 'messageId', Message));
  add('jobs.payload.messageId -> existing messages', await dangling(Job, scope, 'payload.messageId', Message));
  add('evalitems.evidenceMessageIds -> existing messages', await dangling(EvalItem, scope, 'evidenceMessageIds', Message));

  // 4) A specific erasure: the erased ids appear nowhere
  if (messageIds.length > 0) {
    const ids = messageIds.map((id) => toObjectId(String(id), 'messageId'));
    const inIds = { $in: ids };
    const found = [
      ...(await Message.find({ _id: inIds }).select('_id').lean()).map((m) => `message ${m._id}`),
      ...(await Memory.find({ ...scope, sourceMessageIds: inIds }).select('_id').lean()).map((m) => `memory ${m._id}`),
      ...(await Suggestion.find({ ...scope, messageId: inIds }).select('_id').lean()).map((m) => `suggestion ${m._id}`),
      ...(await Job.find({ ...scope, 'payload.messageId': inIds }).select('_id').lean()).map((m) => `job ${m._id}`),
      ...(await EvalItem.find({ ...scope, evidenceMessageIds: inIds }).select('_id').lean()).map((m) => `evalitem ${m._id}`),
      ...(await AuditLog.find({ ...scope, $or: [{ 'before.sourceMessageIds': inIds }, { 'after.sourceMessageIds': inIds }] }).select('_id').lean()).map((m) => `auditlog ${m._id}`),
    ];
    add('erased message ids are referenced nowhere', found);
  }

  // 5) A phrase of the erased text appears in no memory, suggestion or audit snapshot (case-insensitive)
  if (typeof text === 'string' && text.trim() !== '') {
    const re = new RegExp(escapeRegex(text.trim()), 'i');
    const found = [
      ...(await Memory.find({ ...scope, content: re }).select('_id').lean()).map((m) => `memory ${m._id}`),
      ...(await Suggestion.find({ ...scope, content: re }).select('_id').lean()).map((m) => `suggestion ${m._id}`),
      ...(await AuditLog.find({ ...scope, $or: [{ 'before.content': re }, { 'after.content': re }] }).select('_id').lean()).map((m) => `auditlog ${m._id}`),
    ];
    add(`no stored memory text contains "${text.trim()}"`, found);
  }

  return { ok: checks.every((c) => c.ok), scope: userId ? { userId: String(userId) } : 'all users', checkedAt: new Date(), checks };
}

module.exports = { verifyErasure };
