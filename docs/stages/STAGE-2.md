# Stage 2: Bi-temporal memory schema (viva notes)

Pull request: see the "Stage 2: Bi-temporal memory schema" PR into `main` (stacked on nothing: Stage 1 is
already merged).

## 1. In one paragraph
Until Stage 1 a memory was one document that an update simply overwrote, so the system forgot what it used to
believe and could not say when something stopped being true. That is exactly what goes wrong in AI memory: a user
moves city or changes a goal, and the assistant either keeps the old fact or loses the history. Stage 2 stores
every memory as a **chain of versions**, each with two time intervals: **valid time** (`validFrom`, `validTo`: when
the fact was true in the user's life) and **transaction time** (`recordedAt`, `retractedAt`: when the database
believed it). An update **supersedes** the old version instead of overwriting it, inside a **MongoDB transaction**
that also writes an **append-only audit log**. The API can now answer "what is true now?", "what was true on date
T?" (`?asOf=`) and "what did we believe at moment K?" (`?knownAt=`). This is the core of the project's thesis:
the later stages (LLM extraction, retrieval, evaluation, erasure) all build on these versions.

## 2. What changed
| File | Why |
|---|---|
| `models/Memory.js` | New fields: `validFrom`, `validTo`, `recordedAt`, `retractedAt`, `closedAt`, `sourceMessageIds`, `confidence`, `sensitivity`, `supersedes`, `supersededBy`, `lastAccessedAt`, `accessCount`. Indexes redesigned for current-state and time-travel queries (ESR comment on each) plus a unique partial index on `supersedes` |
| `models/AuditLog.js` (new) | The `auditlog` collection: `userId`, `memoryId`, `action`, `actorId`, `at`, `before`, `after`. Mongoose hooks refuse updates and single deletes (append-only) |
| `services/memoryService.js` | Create writes a first version; update = supersede or correction; delete = retraction; `getHistory` (`$graphLookup`); `temporalFilter` for `asOf` / `knownAt`; stats and search only count current versions; health facts default to `special`; `sourceMessageIds` validated |
| `services/transaction.js` (new) | `withTransaction(fn)`: runs the writes all-or-nothing; turns the "not a replica set" error into a clear `503` |
| `services/auditService.js` (new) | Writes an audit entry inside the caller's transaction; `GET /api/audit` listing |
| `services/categoryService.js` | A category is "in use" while any **believed** version (current or past) uses it; retracted versions do not block |
| `services/conversationService.js` | Delete runs in a transaction and also removes the deleted message ids from `sourceMessageIds` |
| `services/userService.js` | Account delete runs in a transaction and also removes the user's audit entries |
| `routes/memory.js`, `routes/audit.js` (new), `app.js` | `GET /api/memories/:id/history`, `GET /api/audit`, `?asOf=` / `?knownAt=`; endpoint list updated |
| `index.js` | Warns at startup when MongoDB is not a replica set |
| `scripts/migrate-stage2.js` (new), `scripts/migrate.js` (new) | Converts Stage 1 memories to first versions, safe to run twice; `npm run migrate` now runs Stage 1 then Stage 2 |
| `scripts/explain.js` | Plans for the current-state, `asOf`, `knownAt`, history and audit queries |
| `seed.js` | Three version chains (Priya's city move, Daniel's career goal, Aarav's corrected placement month) and an audit entry per change |
| `tests/temporal.test.js` (new) | 29 tests: new fields, supersede, correction, retraction, history, `asOf` vs `knownAt`, audit log, concurrent updates, transaction rollback |
| `tests/migration-stage2.test.js` (new) | The migration converts correctly, never overwrites, and is a no-op the second time |
| `tests/indexes.test.js`, `tests/helpers.js`, other tests | New index list; time-travel queries use an index with no `SORT`; tests stop early if MongoDB is not a replica set; Stage 1 tests follow the new version ids |
| `.github/workflows/ci.yml` | Starts MongoDB 7 and 8 in Docker as a single-node replica set; runs `npm run migrate` as a no-op check |
| `README.md`, `.env.example` | Replica-set setup, new endpoints, bi-temporal section with a worked example, data model, index table |

## 3. Concepts
- **Bi-temporal data** (Snodgrass; SQL:2011 calls the two axes *application time* and *system time*): every
  fact carries two independent time intervals.
- **Valid time** (application time): when the fact is true in the real world. Here `[validFrom, validTo)`.
- **Transaction time** (system time): when the database held the fact. Here `[recordedAt, retractedAt)`. Only the
  server clock sets it, so it cannot be faked by a client.
- **Half-open interval** `[from, to)`: includes the start, excludes the end, so consecutive versions meet with no
  gap and no overlap.
- **Time-travel / as-of query**: SQL:2011 `FOR SYSTEM_TIME AS OF`. Here `?knownAt=` (transaction time) and
  `?asOf=` (valid time).
- **Versioning instead of update-in-place**: like a *Type 2 slowly changing dimension* in data warehousing: close
  the old row, insert a new one.
- **Logical deletion** (soft delete, tombstone): a delete sets `retractedAt`; the row stays.
- **Version chain**: a doubly linked list (`supersedes` back, `supersededBy` forward).
- **Recursive query**: `$graphLookup` follows the links like SQL's `WITH RECURSIVE`.
- **ACID transaction / atomicity**: insert new version + close old version + audit entry commit together or not
  at all (rollback). MongoDB supports multi-document transactions only on a **replica set** (or sharded cluster),
  because they rely on the replication machinery (the oplog and majority commit).
- **Optimistic concurrency control**: closing the old version uses a conditional update (`supersededBy: null`).
  If another request got there first, nothing matches and the request gets `409`. Two concurrent transactions on
  the same document hit a **write conflict**, and the loser is retried and then sees the version is no longer
  current.
- **Unique partial index**: `{ supersedes: 1 }` unique, only on documents where `supersedes` is an ObjectId: the
  database itself guarantees that no version has two successors.
- **Append-only log / audit trail**: entries are inserted, never changed. Related to *event sourcing*.
- **Provenance / data lineage**: `sourceMessageIds` records which messages a memory came from.
- **ESR rule**: Equality, Sort, Range. "Current" is the equality `validTo: null, retractedAt: null`; the
  time-travel index puts the ranges (`validFrom`, `recordedAt`) after the sort key `_id`.
- **Idempotent migration**: running it again changes nothing (`$ifNull`, and it only picks documents without
  `recordedAt`).
- **Special-category data**: health data under GDPR Art. 9, hence the default sensitivity `special`.

## 4. Examiner questions
1. **What is the difference between valid time and transaction time?**
   Valid time is when the fact was true for the user (Priya lived in Kochi from 2019 to Aug 2024). Transaction time
   is when our database believed it (we recorded Kochi in Feb 2023 and learned about the move on 20 Aug 2024).
   They differ whenever we learn something late or fix a mistake.
2. **Why not just overwrite the document and keep `updatedAt`?**
   Overwriting destroys the old value, so we can't answer "where did she live in 2023?" or "what did the assistant
   believe when it gave that answer?". `updatedAt` only says *that* something changed, not what it was before.
3. **What exactly happens on `PUT /api/memories/:id`?**
   In one transaction: read the version (must be current), insert a new version with `supersedes = old._id`, set the
   old version's `validTo` (= new `validFrom`), `closedAt` and `supersededBy`, and insert an audit entry. Returns the
   new version.
4. **Why do you need a transaction there? Why a replica set?**
   Three writes must all happen or none. A crash after the insert but before closing the old version would leave
   two current versions. MongoDB only runs multi-document transactions on a replica set, because commit relies on
   the replication log; a single-node replica set is enough.
5. **What does `?asOf=2024-08-10&knownAt=2024-08-15` return for Priya, and why?**
   Kochi. On 15 Aug the database did not yet know about the move (recorded 20 Aug), so the Bengaluru version is
   filtered out by `recordedAt <= knownAt`, and the Kochi version's `validTo` was only written on 20 Aug
   (`closedAt > knownAt`), so at that time it still looked open.
6. **Supersede, correction and retraction: what is the difference?**
   Supersede: the world changed, so valid time of the old version ends. Correction: the old version was wrong,
   so its transaction time ends (`retractedAt`) and the new version takes over the same valid time. Retraction
   (delete): we stop believing a version; nothing replaces it.
7. **How is the "current" list fast?**
   "Current" is written as an equality (`validTo: null, retractedAt: null`), so it goes in the equality part of
   `{ userId, validTo, retractedAt, _id: -1 }`, then `_id` gives the order: no `SORT`, no `COLLSCAN`
   (checked by `npm run explain` and the index tests).
8. **How does the history endpoint find all versions?**
   One aggregation with two `$graphLookup` stages: one follows `supersedes` backwards, one follows `supersededBy`
   forwards. Each hop is a lookup on `_id` (indexed). The versions are then ordered by `recordedAt`.
9. **What stops two simultaneous updates from creating two "current" versions?**
   Three things: the old version is closed with a conditional update (`supersededBy: null`), concurrent
   transactions on the same document raise a write conflict, and the unique partial index on `supersedes` makes a
   second successor impossible. The test fires two updates at once and gets exactly one `200` and one `409`.
10. **Is the audit log really append-only? And is the migration safe to run twice?**
    In the application, yes: the model refuses updates and single deletes, and only account deletion removes
    entries. A database administrator could still edit it (see weak points). The migration only touches memories
    without `recordedAt` and fills fields with `$ifNull`, so a second run converts 0 memories (tested).

## 5. Weak points
- **The old version's `validTo` is written in place.** A textbook bi-temporal table never changes a row: it would
  retract the old row and insert a closed copy. I store `closedAt` (when `validTo` was written) instead, so
  `knownAt` queries still see `validTo` as it was known. If asked: "same answers, one row fewer per change; the
  trade-off is one extra field".
- **Append-only is enforced by the application, not the database.** Someone with direct database access can still
  edit `auditlog`. Fixes: a MongoDB role without `update`/`remove` on that collection, or hash-chaining entries so
  tampering is detectable.
- **The audit log copies personal data** (before/after snapshots). Erasing one memory for good therefore also
  needs the log entries handled. That is Stage 7 (hard erasure). Today only deleting the whole account removes them.
- **No future-dated facts** (`validFrom` must not be in the future), so "I move to Pune next month" cannot be
  stored ahead of time. That keeps "current" a simple equality that indexes well.
- **Every edit creates a version**, even changing Active to Archived, so storage grows with edits. Usage counters
  (`accessCount`, `lastAccessedAt`) are updated in place on purpose, because reading is not a change of belief, but
  it means a read is also a small write.
- **Server clock as transaction time.** Two changes in the same millisecond, or a server with a wrong clock, would
  blur the order. One MongoDB primary and one app server make this unlikely here.
- **Sensitivity is a simple rule** (Health means `special`). Stage 3's extractor will classify sensitivity per fact.
- **A category used only by retracted versions can be deleted**, so those retracted versions show no category name.
  They are hidden from all normal queries; it is a deliberate choice so old deletes don't block admins forever.
- **Replica set needed on every laptop.** One-time setup below; without it, reads work and writes return `503`.

## 6. Demo on your laptop

### One-time: turn your Windows MongoDB service into a replica set
Open **PowerShell as Administrator**.

```powershell
# 1. Find the config file the MongoDB service uses (look for --config "...mongod.cfg")
(Get-CimInstance Win32_Service -Filter "Name='MongoDB'").PathName

# 2. Put that path in a variable (adjust 7.0 to the version shown above) and back the file up
$cfg = "C:\Program Files\MongoDB\Server\7.0\bin\mongod.cfg"
Copy-Item $cfg "$env:USERPROFILE\mongod.cfg.bak"

# 3. Check there is no active "replication:" line yet (this must print nothing)
Select-String -Path $cfg -Pattern '^replication:'

# 4. Add the replica-set setting (two spaces before replSetName, no tabs)
Add-Content -Path $cfg -Value "`r`nreplication:`r`n  replSetName: rs0"

# 5. Restart the service and initialise the replica set once
Restart-Service MongoDB
mongosh --quiet --eval "rs.initiate({_id: 'rs0', members: [{_id: 0, host: 'localhost:27017'}]})"

# 6. Check: both should print 1 / true (wait a few seconds after step 5)
mongosh --quiet --eval "rs.status().ok"
mongosh --quiet --eval "db.hello().isWritablePrimary"
```

- If `mongosh` is not found, install the MongoDB Shell: `winget install MongoDB.Shell`, then open a new PowerShell.
- If the service does not start after step 5, the config file has a typo (usually a tab or wrong indentation).
  Look at the end of the log: `Get-Content "C:\Program Files\MongoDB\Server\7.0\log\mongod.log" -Tail 20`.
- To undo: `Copy-Item "$env:USERPROFILE\mongod.cfg.bak" $cfg -Force; Restart-Service MongoDB`.
- Your `.env` does not change: `MONGO_URI=mongodb://127.0.0.1:27017/aimemory` still works.
- Docker instead: `docker run -d --name mongo -p 27017:27017 mongo:7 --replSet rs0`, then the `rs.initiate` line
  above with `docker exec mongo mongosh ...` in front.

### Run it
In the project folder (normal PowerShell):

```powershell
git checkout claude/stage-2-temporal-schema   # or main, once this stage is merged
npm install
npm test                 # all suites pass; it stops early with a clear message if MongoDB is not a replica set
npm run migrate          # upgrades your existing Stage 1 data; run it again and it converts 0 memories
npm run seed             # 61 memory versions, 58 current, 3 version chains
npm run explain          # query plans: no COLLSCAN, no SORT for the memory queries
npm start                # leave this window open; use a second PowerShell window below
```

### Show the bi-temporal queries (second PowerShell window)
```powershell
$login = Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/auth/login -ContentType 'application/json' -Body '{"email":"priya.nair@example.com","password":"DevPassword123"}'
$h = @{ Authorization = "Bearer $($login.token)" }

# Valid time: where did she live in mid-2023 (as we know it today)? -> Kochi
(Invoke-RestMethod "http://localhost:5000/api/memories?asOf=2023-06-01&category=personal" -Headers $h).memories.content

# Same date of the world, two moments of knowledge -> Kochi, then Bengaluru
(Invoke-RestMethod "http://localhost:5000/api/memories?asOf=2024-08-10&knownAt=2024-08-15&category=personal" -Headers $h).memories.content
(Invoke-RestMethod "http://localhost:5000/api/memories?asOf=2024-08-10&category=personal" -Headers $h).memories.content

# The version chain
$city = (Invoke-RestMethod "http://localhost:5000/api/memories?asOf=2024-08-10&category=personal" -Headers $h).memories | Where-Object content -like '*Bengaluru*'
(Invoke-RestMethod "http://localhost:5000/api/memories/$($city._id)/history" -Headers $h).versions | Select-Object content, validFrom, validTo, recordedAt, isCurrent

# Supersede live: a new version appears, the old id can no longer be updated (409)
$new = Invoke-RestMethod -Method Put -Uri "http://localhost:5000/api/memories/$($city._id)" -Headers $h -ContentType 'application/json' -Body '{"content":"User moved from Bengaluru to Pune."}'
$new | Select-Object _id, content, supersedes, validFrom
try { Invoke-RestMethod -Method Put -Uri "http://localhost:5000/api/memories/$($city._id)" -Headers $h -ContentType 'application/json' -Body '{"content":"x"}' } catch { $_.ErrorDetails.Message }

# The audit trail of what just happened
(Invoke-RestMethod "http://localhost:5000/api/audit?limit=3" -Headers $h).entries | Select-Object action, at, memoryId
```
