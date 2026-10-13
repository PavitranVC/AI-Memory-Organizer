const Memory = require('../models/Memory');
const { badRequest } = require('./errors');
const { withTransaction } = require('./transaction');
const erasure = require('./erasureService');

const DAY_MS = 24 * 60 * 60 * 1000;

// Stage 7 retention policy: a "special"-sensitivity memory version (health and similar facts) is kept for
// RETENTION_SPECIAL_DAYS after it was recorded, then erased. Not set or 0 = no automatic expiry.
//
// Why a scheduled job and not a MongoDB TTL index: a TTL index deletes documents in the background, one by one,
// outside any transaction and without running application code. It would leave the version chain pointing at
// missing versions, leave the audit log quoting the deleted text, and change the period only through collMod.
// The job below reuses the same erasure code as message deletion, so expiry is as complete as any erasure and
// is itself logged. Run it on a schedule (cron, Windows Task Scheduler) with "npm run retention".
function retentionDays(value = process.env.RETENTION_SPECIAL_DAYS) {
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) throw badRequest('RETENTION_SPECIAL_DAYS must be a number of days (0 = off)');
  return days;
}

// Dataset rows (benchmark / synthetic, Stage 5) are not real people's data and are kept fixed so benchmark
// runs stay reproducible, so they are never expired.
function expiredFilter(cutoff) {
  return { sensitivity: 'special', recordedAt: { $lt: cutoff }, dataset: null };
}

// Erases every expired special version, one transaction per user. dryRun only counts.
async function purgeExpired({ days = retentionDays(), now = new Date(), dryRun = false, log = null } = {}) {
  if (!(days > 0)) return { enabled: false, days: 0, cutoff: null, users: 0, expiredVersions: 0, erasedVersions: 0, restoredVersions: 0 };
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  // Served by the partial { recordedAt } index that holds only special versions
  const expired = await Memory.find(expiredFilter(cutoff)).select('_id userId').lean();
  const byUser = new Map();
  for (const m of expired) {
    const key = String(m.userId);
    if (!byUser.has(key)) byUser.set(key, { userId: m.userId, ids: [] });
    byUser.get(key).ids.push(m._id);
  }
  const result = { enabled: true, days, cutoff, dryRun, users: byUser.size, expiredVersions: expired.length, erasedVersions: 0, restoredVersions: 0 };
  if (dryRun) return result;
  for (const { userId, ids } of byUser.values()) {
    const counts = await withTransaction((session) =>
      erasure.eraseVersions(userId, ids, session, { at: now, reason: `retention: special data older than ${days} days`, via: 'retention', actorId: null })
    );
    result.erasedVersions += counts.erasedVersions;
    result.restoredVersions += counts.restoredVersions;
    if (log) log(`[retention] user ${userId}: erased ${counts.erasedVersions}, restored ${counts.restoredVersions}`);
  }
  return result;
}

module.exports = { retentionDays, expiredFilter, purgeExpired };
