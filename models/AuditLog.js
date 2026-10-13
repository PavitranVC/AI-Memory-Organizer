const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const ACTIONS = ['create', 'supersede', 'correct', 'retract', 'migrate'];

// Append-only record of every change to a memory: who did what, when, and the version before and after.
// Entries are only ever inserted. The hooks below make Mongoose refuse updates and deletes, so the
// application cannot rewrite history by accident. deleteMany is left open for one purpose only: deleting a
// whole account (userService.deleteUser), because erasing a person's data must also erase the copies of it
// kept in the log. (The tests also use it to empty the collection.)
const auditLogSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true }, // whose data changed (scopes every query)
    memoryId: { type: ObjectId, ref: 'Memory', required: true }, // the version the action produced or closed
    action: { type: String, enum: ACTIONS, required: true },
    actorId: { type: ObjectId, ref: 'User', default: null }, // who made the change (null = a script)
    at: { type: Date, required: true, default: Date.now },
    before: { type: Object, default: null }, // snapshot of the old version (null on create)
    after: { type: Object, default: null }, // snapshot of the new or closed version
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

module.exports = mongoose.model('AuditLog', auditLogSchema);
module.exports.ACTIONS = ACTIONS;
