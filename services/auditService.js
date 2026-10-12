const AuditLog = require('../models/AuditLog');
const { toObjectId } = require('./ids');
const { paginate } = require('./pagination');

// Strips Mongoose internals so the log stores a plain copy of the version as it was at that moment
function snapshot(doc) {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject({ depopulate: true }) : { ...doc };
  delete plain.__v;
  return plain;
}

// Called inside the same transaction as the change it records, so a change is never saved without its
// log entry (or the other way round).
async function record({ userId, memoryId, action, actorId = null, at = new Date(), before = null, after = null }, session) {
  const [entry] = await AuditLog.create(
    [{ userId, memoryId, action, actorId, at, before: snapshot(before), after: snapshot(after) }],
    { session }
  );
  return entry;
}

// The caller's own log, newest first. ?memoryId= narrows it to one version.
async function listAudit(userId, query = {}) {
  const filter = { userId };
  if (query.memoryId !== undefined) filter.memoryId = toObjectId(query.memoryId, 'memoryId');
  const { items, limit, nextCursor } = await paginate(AuditLog, filter, query);
  return { count: items.length, limit, nextCursor, entries: items };
}

module.exports = { record, listAudit, snapshot };
