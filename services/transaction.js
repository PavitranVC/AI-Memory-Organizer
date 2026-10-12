const mongoose = require('mongoose');
const { HttpError } = require('./errors');

// Runs fn(session) in a MongoDB transaction: every write inside commits together or not at all.
// Mongoose retries fn on transient errors (for example a write conflict with a concurrent request), so fn
// must read what it needs inside the transaction, using the session.
async function withTransaction(fn) {
  try {
    let result;
    await mongoose.connection.transaction(async (session) => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    // Code 20 (IllegalOperation): a standalone mongod, which cannot run transactions
    if (err.code === 20 && /replica set|Transaction numbers/i.test(err.message)) {
      throw new HttpError(503, 'MongoDB must run as a replica set to save changes (transactions). See "Run MongoDB as a replica set" in the README.');
    }
    throw err;
  }
}

module.exports = { withTransaction };
