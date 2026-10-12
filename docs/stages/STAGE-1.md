# Stage 1: Database hardening (viva notes)

Pull request: https://github.com/PavitranVC/AI-Memory-Organizer/pull/1 (merged)

## 1. In one paragraph
The review version stored memories correctly but trusted everything it was sent. Any request could read any
user's data, references to categories and conversations were never checked, indexes were partly redundant,
lists returned everything at once, and nothing was tested. Stage 1 turns it into a database a real application
could sit on:
- every query is limited to the logged-in user,
- references are checked in a service layer (MongoDB has no foreign keys),
- indexes follow the ESR rule and are verified with `explain()`,
- lists are paginated with a cursor,
- 120 automated tests run on every push.

## 2. What changed
| File(s) | Why |
|---|---|
| `models/Memory.js` | Indexes redesigned with the ESR rule; standalone `userId` and `status` removed; text index now starts with `userId`; `importance` must be a whole number |
| `models/Message.js` (new) | Messages moved out of conversations into their own collection, indexed on `{ conversationId, sentAt }` |
| `models/Conversation.js` | No embedded `messages` array any more; index `{ userId, _id: -1 }` |
| `models/User.js` | `passwordHash` (bcrypt, never returned) and `role` (`user` / `admin`) |
| `models/Category.js` | Case-insensitive unique name index (`name_unique_ci`) |
| `services/*.js` (new) | All rules live here: ownership checks, reference checks, cascades, pagination, aggregations, auth |
| `middleware/auth.js` | Reads the `Authorization: Bearer <token>` header, verifies the JWT, loads the user |
| `routes/*.js` | Thin HTTP layer: auth, users, categories, conversations, memories |
| `app.js` / `index.js` | App separated from the server so tests can load it; error handler maps errors to 400/401/403/404/409 |
| `seed.js` | Hashed dev password, messages in their own collection, one admin |
| `scripts/explain.js` | Prints indexes and query plans; fails on duplicate indexes or a collection scan |
| `scripts/migrate-stage1.js` | Upgrades a review-version database; safe to run twice |
| `tests/*.test.js` | 120 tests against a real MongoDB |
| `.github/workflows/ci.yml` | Runs the tests on Node 20/22 with MongoDB 7 and 8 on every push |
| `README.md` | Setup, API, ER diagram, index table, limitations |

## 3. Concepts
- **Referential integrity**: a reference must point at a row/document that exists. SQL enforces it with foreign
  keys; MongoDB doesn't, so the service layer checks it before every write.
- **ON DELETE RESTRICT / CASCADE**: deleting a category that is in use is refused (restrict, `409`). Deleting a
  user deletes their data (cascade). Both are done in code.
- **Authentication vs authorisation**: the JWT proves *who* you are (authentication). Filtering every query by your
  `userId` decides *what* you may touch (authorisation).
- **Password hashing (bcrypt)**: a slow, salted one-way function. A stolen database doesn't reveal passwords.
- **NoSQL injection**: sending `{ "$gt": "" }` instead of a string can turn a filter into "match anything". Login
  rejects anything that isn't a plain string.
- **ESR rule**: in a compound index, put **E**quality fields first, then the **S**ort field, then **R**ange fields.
  The index then returns rows already in order, with no in-memory sort.
- **Index selectivity / low cardinality**: `status` has only two values, so an index on it alone barely narrows
  the search.
- **Index prefix**: `{ userId, _id }` already serves queries on `userId` alone, so a separate `{ userId }` index is
  redundant.
- **Keyset (cursor) pagination**: "give me 20 items with `_id` less than X" instead of "skip 40, take 20". It stays
  fast on deep pages and doesn't shift when rows are added.
- **Query plan (`explain`)**: IXSCAN means an index was used; COLLSCAN means the whole collection was read.
  MongoDB 8 shows EXPRESS_IXSCAN for simple single-field lookups.
- **Aggregation pipeline**: `$match` → `$group` → `$lookup` (a join) → `$project` → `$sort`.
- **Denormalisation vs separate collection**: embedding messages is fast to read but grows without limit (16 MB
  document cap), so messages now have their own collection.

## 4. Examiner questions
1. **Why not foreign keys?** MongoDB has none. `services/` checks every reference before writing and returns `400`
   if it doesn't exist or isn't yours.
2. **How do you stop user A from reading user B's memories?** The user id comes from the verified token, never
   from the request, and every query includes `userId` in its filter.
3. **Why does someone else's memory return 404, not 403?** A 403 would confirm that the id exists. 404 reveals
   nothing.
4. **Explain your memory indexes.** `{userId,_id}` lists a user's memories newest first. `{userId,status,_id}` and
   `{userId,categoryId,_id}` serve the two filters. `{categoryId}` serves the "category in use?" check. The text
   index is prefixed with `userId`. Each follows ESR, and `explain` shows IXSCAN.
5. **Why remove the `status` index?** Two values = low selectivity. And `userId` alone is a prefix of the compound
   indexes.
6. **Why cursor pagination?** `skip` gets slower the deeper you go and can skip or repeat items when data
   changes. A cursor on `_id` uses the index and is stable.
7. **What was wrong with the old by-category aggregation?** `$unwind` dropped memories whose category was missing,
   so the counts didn't add up. `preserveNullAndEmptyArrays` keeps them and labels them "(unknown category)".
8. **Why move messages out of conversations?** An embedded array grows forever, and a MongoDB document is capped
   at 16 MB.
9. **Are your cascade deletes atomic?** No: a single MongoDB server has no multi-document transactions. Children
   are deleted first and the parent last, so a failed delete can be repeated. Stage 2 adds a replica set and
   transactions.
10. **How do you know it works?** 120 automated tests against a real database, including user isolation and
    index-use checks. Deliberately breaking scoping or the delete check makes a test fail. CI runs them on every
    push.

## 5. Weak points
- **Login is basic.** There's no password reset, refresh token or rate limiting. *Answer:* out of scope for a DBMS
  project; it's in the README as a known limitation.
- **Cascades aren't transactional.** *Answer:* done deliberately in a retry-safe order; fixed in Stage 2 with
  transactions.
- **The messages query has an in-memory SORT.** *Answer:* the `_id` tie-break isn't in the index; adding it as a
  third key would remove the sort. It only sorts one conversation's messages.
- **Search is keyword-based.** *Answer:* semantic (vector) search is Stage 4.
- **Categories are shared and admin-only.** *Answer:* a design choice; per-user categories would be a small change.

## 6. Demo on your laptop
```powershell
cd C:\Education\VIT\Projects\AI-Memory-Organizer
git checkout main
git pull
npm install
npm run seed
npm test
npm run explain
npm start
```
In a second terminal:
```powershell
$r = Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/auth/login -ContentType 'application/json' -Body '{"email":"priya.nair@example.com","password":"DevPassword123"}'
$h = @{ Authorization = "Bearer $($r.token)" }
Invoke-RestMethod "http://localhost:5000/api/memories?limit=3" -Headers $h
Invoke-RestMethod "http://localhost:5000/api/memories/stats/by-category" -Headers $h
Invoke-RestMethod "http://localhost:5000/api/memories" ; # no token -> 401
```
