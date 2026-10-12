const mongoose = require('mongoose');
const { badRequest } = require('./errors');

// Validates a client-supplied id and returns an ObjectId. Using this everywhere also stops
// objects like { "$gt": "" } from sneaking into a query filter.
function toObjectId(id, field = 'id') {
  if (typeof id !== 'string' && !(id instanceof mongoose.Types.ObjectId)) {
    throw badRequest(`Invalid ${field}`);
  }
  if (!mongoose.isObjectIdOrHexString(id)) throw badRequest(`Invalid ${field}: ${id}`);
  return new mongoose.Types.ObjectId(String(id));
}

module.exports = { toObjectId };
