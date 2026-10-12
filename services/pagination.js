const { badRequest } = require('./errors');
const { toObjectId } = require('./ids');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ?limit= must be a positive integer; anything above MAX_LIMIT is capped (the response reports the limit used)
function parseLimit(raw) {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) throw badRequest('limit must be a positive integer');
  return Math.min(n, MAX_LIMIT);
}

// ?cursor= is the _id of the last item of the previous page
function parseCursor(raw) {
  return raw === undefined ? null : toObjectId(raw, 'cursor');
}

// Keyset pagination on _id: stable when rows are inserted or deleted between requests, and it
// never skips rows the way skip/limit does. Fetches one extra row to know whether a next page exists.
async function paginate(Model, filter, query, { order = 'desc', populate } = {}) {
  const limit = parseLimit(query.limit);
  const cursor = parseCursor(query.cursor);
  const direction = order === 'asc' ? 1 : -1;

  const finalFilter = cursor ? { ...filter, _id: { [direction === 1 ? '$gt' : '$lt']: cursor } } : filter;
  let find = Model.find(finalFilter).sort({ _id: direction }).limit(limit + 1);
  if (populate) find = find.populate(populate);
  const rows = await find;

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, limit, nextCursor: hasMore ? items[items.length - 1]._id : null };
}

module.exports = { paginate, parseLimit, parseCursor, DEFAULT_LIMIT, MAX_LIMIT };
