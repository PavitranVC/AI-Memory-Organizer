const Memory = require('../models/Memory');
const AuditLog = require('../models/AuditLog');
const Suggestion = require('../models/Suggestion');
const Job = require('../models/Job');
const EvalItem = require('../models/EvalItem');
const audit = require('./auditService');

// Stage 7: HARD erasure. Everything here runs inside the caller's transaction (session), so an erasure either
// happens completely (versions, chain repair, audit tombstones, suggestions, jobs) or not at all.
//
// Lineage: every memory version lists the messages it was derived from (sourceMessageIds, Stage 2 provenance).
// Erasing messages therefore erases:
//  - every version derived ONLY from erased messages (deleted, with its embedding, which lives in the same document);
//  - nothing else: a version that also has other sources is kept, the erased ids are removed from its sources,
//    and it is flagged for review (erasureReview), because its text may still contain something from them.

const ids = (list) => list.map((x) => String(x));

// Loads every version in the chains that contain the given versions. A chain is a doubly linked list
// (supersedes / supersededBy), so each round follows the links one step further; chains are short.
async function loadChains(userId, startIds, session) {
  const loaded = new Map();
  let frontier = startIds;
  while (frontier.length > 0) {
    const rows = await Memory.find({ _id: { $in: frontier }, userId })
      .select('_id supersedes supersededBy validTo closedAt retractedAt recordedAt')
      .session(session)
      .lean();
    for (const row of rows) loaded.set(String(row._id), row);
    const next = new Set();
    for (const row of rows) {
      for (const link of [row.supersedes, row.supersededBy]) {
        if (link && !loaded.has(String(link))) next.add(String(link));
      }
    }
    frontier = [...next];
  }
  // Order each chain from its first version (supersedes = null, or pointing outside the loaded set)
  const chains = [];
  for (const row of loaded.values()) {
    if (row.supersedes && loaded.has(String(row.supersedes))) continue;
    const chain = [];
    for (let v = row; v; v = v.supersededBy ? loaded.get(String(v.supersededBy)) : null) chain.push(v);
    chains.push(chain);
  }
  return chains;
}

// Plans the repair of one chain after some of its versions are erased:
//  - the surviving versions are linked to each other, skipping the erased ones;
//  - if the erased versions included the current one (the end of the chain) and the last survivor was closed
//    by an erased version, the survivor is RESTORED (made current again): the database goes back to what it
//    would hold had the erased message never been said. A survivor the user retracted stays retracted.
function planChain(chain, erased, at) {
  const survivors = chain.filter((v) => !erased.has(String(v._id)));
  if (survivors.length === 0 || survivors.length === chain.length) return { updates: [], restored: [] };
  const head = chain[chain.length - 1];
  const headWasCurrent = head.validTo === null && head.retractedAt === null;
  const updates = [];
  const restored = [];
  survivors.forEach((v, i) => {
    const set = {};
    const prev = i > 0 ? survivors[i - 1]._id : null;
    const next = i + 1 < survivors.length ? survivors[i + 1]._id : null;
    if (String(v.supersedes) !== String(prev)) set.supersedes = prev;
    if (String(v.supersededBy) !== String(next)) set.supersededBy = next;
    const lastSurvivor = i === survivors.length - 1;
    if (lastSurvivor && v.supersededBy && erased.has(String(v.supersededBy))) {
      const closer = chain.find((c) => String(c._id) === String(v.supersededBy));
      // A correction retracts the old version at the very moment the new one is recorded; a user's own
      // DELETE does not, and is respected.
      const correctedByCloser = v.retractedAt && closer && v.retractedAt.getTime() === closer.recordedAt.getTime();
      if (headWasCurrent && correctedByCloser) {
        Object.assign(set, { retractedAt: null, erasureReview: { at, reason: 'restored: the version that corrected it was erased' } });
        restored.push(v._id);
      } else if (headWasCurrent && v.validTo && !v.retractedAt) {
        Object.assign(set, { validTo: null, closedAt: null, erasureReview: { at, reason: 'restored: the version that superseded it was erased' } });
        restored.push(v._id);
      } else {
        set.erasureReview = { at, reason: 'a later version was erased' };
      }
    }
    if (Object.keys(set).length > 0) updates.push({ updateOne: { filter: { _id: v._id }, update: { $set: set } } });
  });
  return { updates, restored };
}

// Hard-deletes the given versions of one user and repairs everything that pointed at them.
// options: { at, reason, via } are written to the audit log ("erase" entries keep no content).
async function eraseVersions(userId, versionIds, session, { at = new Date(), reason = 'erasure', via = 'api', actorId = userId } = {}) {
  const erasedIds = [...new Set(ids(versionIds))];
  if (erasedIds.length === 0) return { erasedVersions: 0, restoredVersions: 0, tombstonedAuditEntries: 0 };
  const erased = new Set(erasedIds);
  const chains = await loadChains(userId, erasedIds, session);
  const plans = chains.map((chain) => planChain(chain, erased, at));
  const restored = plans.flatMap((p) => p.restored);

  // Delete first, then relink: the unique index on "supersedes" must never see two versions claiming the
  // same predecessor, which could happen for a moment if a survivor were relinked while the erased one existed.
  const objectIds = chains.flat().filter((v) => erased.has(String(v._id))).map((v) => v._id);
  const { deletedCount } = await Memory.deleteMany({ _id: { $in: objectIds }, userId }, { session });
  const updates = plans.flatMap((p) => p.updates);
  if (updates.length > 0) await Memory.bulkWrite(updates, { session });

  // The audit log keeps that something was erased, never what
  const tombstoned = await AuditLog.tombstone(userId, objectIds, at, session);
  for (const memoryId of objectIds) {
    await audit.record({ userId, memoryId, action: 'erase', actorId, via, reason, at }, session);
  }
  if (restored.length > 0) {
    const rows = await Memory.find({ _id: { $in: restored } }).session(session);
    for (const row of rows) {
      await audit.record({ userId, memoryId: row._id, action: 'restore', actorId, via, reason: row.erasureReview.reason, at, after: row }, session);
    }
  }
  return { erasedVersions: deletedCount, restoredVersions: restored.length, tombstonedAuditEntries: tombstoned.modifiedCount };
}

// Erases everything derived from the given messages of one user (called before the messages themselves are
// deleted, in the same transaction). Returns counts for the response (an "erasure receipt").
async function eraseByMessages(userId, messageIds, session, { at = new Date(), reason = 'message erased' } = {}) {
  const result = { erasedVersions: 0, restoredVersions: 0, flaggedVersions: 0, tombstonedAuditEntries: 0, deletedSuggestions: 0, deletedJobs: 0 };
  if (messageIds.length === 0) return result;
  const erasedMessages = new Set(ids(messageIds));

  // Lineage lookup on the multikey { userId, sourceMessageIds } index
  const derived = await Memory.find({ userId, sourceMessageIds: { $in: messageIds } }).select('_id sourceMessageIds').session(session).lean();
  const onlyFromErased = derived.filter((m) => m.sourceMessageIds.every((s) => erasedMessages.has(String(s))));
  const partly = derived.filter((m) => !onlyFromErased.includes(m));

  Object.assign(result, await eraseVersions(userId, onlyFromErased.map((m) => m._id), session, { at, reason }));
  if (partly.length > 0) {
    const flagged = await Memory.updateMany(
      { _id: { $in: partly.map((m) => m._id) }, userId },
      { $pull: { sourceMessageIds: { $in: messageIds } }, $set: { erasureReview: { at, reason: 'some of its source messages were erased' } } },
      { session }
    );
    result.flaggedVersions = flagged.modifiedCount;
  }
  await AuditLog.forgetSources(userId, messageIds, session);

  // Other data derived from the messages: pending suggestions, extraction jobs (their results quote topics),
  // and benchmark labels pointing at them as evidence
  result.deletedSuggestions = (await Suggestion.deleteMany({ userId, messageId: { $in: messageIds } }, { session })).deletedCount;
  result.deletedJobs = (await Job.deleteMany({ userId, 'payload.messageId': { $in: messageIds } }, { session })).deletedCount;
  await EvalItem.updateMany({ userId, evidenceMessageIds: { $in: messageIds } }, { $pull: { evidenceMessageIds: { $in: messageIds } } }, { session });
  return result;
}

module.exports = { eraseVersions, eraseByMessages, planChain };
