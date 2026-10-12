const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

// Stage 7 adds "erase" (a version was hard-deleted; the entry keeps no content) and "restore" (a version became
// current again because the later version that closed it was erased).
const ACTIONS = ['create', 'supersede', 'correct', 'retract', 'migrate', 'erase', 'restore'];

// Append-only record of every change to a memory: who did what, when, and the version before and after.
// Entries are only ever inserted. The hooks below make Mongoose refuse updates and deletes, so the
// application cannot rewrite history by accident. There are two deliberate exceptions, both for erasure,
// because erasing a person's data must also erase the copies of it kept in the log:
//  - deleteMany, for deleting a whole account (userService.deleteUser). (The tests also use it to empty the log.)
//  - tombstone() and forgetSources() below (Stage 7), which blank the content of entries about erased data.
//    They go through the raw driver collection on purpose, so they are the ONLY update paths.
const auditLogSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true }, // whose data changed (scopes every query)
    memoryId: { type: ObjectId, ref: 'Memory', required: true }, // the version the action produced or closed
    action: { type: String, enum: ACTIONS, required: true },
    actorId: { type: ObjectId, ref: 'User', default: null }, // who made the change (null = a script)
    at: { type: Date, required: true, default: Date.now },
    before: { type: Object, default: null }, // snapshot of the old version (null on create)
    after: { type: Object, default: null }, // snapshot of the new or closed version
    // Which path made the change: "api" (a client request) or "extractor" (the Stage 3 LLM pipeline).
    // null on entries written before Stage 3.
    via: { type: String, default: null },
    reason: { type: String, default: null }, // why, when the extractor made the change (the reconciler's reason)
    // Stage 7: when the entry's content was blanked because the version it describes was erased. The entry
    // itself stays (action, time, who), so the log still shows THAT something happened, but not WHAT.
    tombstonedAt: { type: Date, default: null },
  },
  { versionKey: false, collection: 'auditlog' }
);

// A user's log, newest first (keyset pagination on _id). E: userId. S: _id.
auditLogSchema.index({ userId: 1, _id: -1 });
// The log of one memory version. E: userId, memoryId. S: _id.
auditLogSchema.index({ userId: 1, memoryId: 1, _id: -1 });

function refuse(next) {
  next(new Error('auditlog is append-only: entries cannot be updated or deleted'));
}
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'findOneAndDelete']) {
  auditLogSchema.pre(op, { document: false, query: true }, refuse);
}
auditLogSchema.pre(['updateOne', 'deleteOne'], { document: true, query: false }, refuse);

// Stage 7. Blanks the snapshots of every entry about the erased versions: the entries that produced or closed
// them (memoryId) and the entries of other versions that quote them as "before" or "after".
auditLogSchema.statics.tombstone = function tombstone(userId, memoryIds, at, session) {
  if (memoryIds.length === 0) return { modifiedCount: 0 };
  const filter = { userId, $or: [{ memoryId: { $in: memoryIds } }, { 'before._id': { $in: memoryIds } }, { 'after._id': { $in: memoryIds } }] };
  return this.collection.updateMany(filter, { $set: { before: null, after: null, reason: null, tombstonedAt: at } }, { session });
};

// Stage 7. Removes erased message ids from the snapshots that still list them as a source (versions that
// survived because they also had other sources), so the log keeps no reference to an erased message.
auditLogSchema.statics.forgetSources = async function forgetSources(userId, messageIds, session) {
  if (messageIds.length === 0) return;
  for (const side of ['before', 'after']) {
    const path = `${side}.sourceMessageIds`;
    await this.collection.updateMany({ userId, [path]: { $in: messageIds } }, { $pull: { [path]: { $in: messageIds } } }, { session });
  }
};

module.exports = mongoose.model('AuditLog', auditLogSchema);
module.exports.ACTIONS = ACTIONS;
