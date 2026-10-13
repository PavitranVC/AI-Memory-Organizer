# Stage 7: Privacy and governance (viva notes)

Branch `claude/stage-7-governance`, stacked on Stage 6 (`claude/stage-6-evaluation`). Built in the overnight run
with the mock LLM only (no API cost). The legal mapping is in `docs/PRIVACY.md`, which **must be checked by a
person** (it has `TODO: verify` items).

## 1. In one paragraph
Stage 7 gives the user control over what the assistant remembers, and makes forgetting exact. The user chooses per
category whether facts are stored, kept as suggestions to approve, or never stored. Deleting a message or a
conversation now erases every memory version that was derived only from it, found through the provenance links
(`sourceMessageIds`) that Stage 2 added, instead of guessing by similar text. The erasure runs in one transaction,
repairs the version chain, blanks the audit log entries about what was erased, and can be proved afterwards by a
verification script. The user can also download everything stored about them as JSON, and health-type
(`special`) memories can expire after a set number of days. This is the last part of the thesis: bi-temporal
memory with provenance "makes user-governed erasure exact", and India's DPDP Act 2023 and the GDPR both give people
rights (consent, erasure, access) that the design now supports.

## 2. What changed
- `models/Consent.js` (new): one row per user and category with mode `store` / `ask` / `never`; unique index on `{ userId, categoryId }`.
- `models/Suggestion.js` (new): facts from "ask" categories waiting for the user's decision; points at its source message (lineage).
- `models/Memory.js`: new field `erasureReview` (flag left by an erasure); new indexes `{ userId, sourceMessageIds }` (lineage, multikey) and `retention_special` (partial index on `recordedAt` for special versions only).
- `models/AuditLog.js`: new actions `erase` and `restore`, field `tombstonedAt`, and two deliberate update paths for erasure (`tombstone`, `forgetSources`).
- `services/erasureService.js` (new): the erasure itself: lineage lookup, delete or flag, version-chain repair (`planChain`), audit tombstones, suggestions and jobs.
- `services/erasureVerifier.js` (new): the anti-join checks that prove nothing derived from erased data remains.
- `services/consentService.js`: was a stub that allowed everything; now reads and sets the mode, refuses "never" categories, and erases a category when consent is withdrawn.
- `services/suggestionService.js` (new): list, accept (becomes a memory), reject.
- `services/exportService.js` (new): every row about the user from every collection.
- `services/retentionService.js` (new): expiry of old special memories through the same erasure code; explains why not a TTL index.
- `services/extractionService.js`: uses the consent mode per candidate fact; "ask" stores a suggestion (decision `ASK`).
- `services/memoryService.js`: refuses to create or move a memory into a "never" category (`409`); `?needsReview=true` filter.
- `services/conversationService.js`: deleting a conversation erases by lineage; new `deleteMessage`.
- `services/userService.js`: account deletion also removes consents and suggestions.
- `services/categoryService.js`: deleting a category also removes its consent rows and suggestions (one transaction).
- `routes/me.js` (new): `/api/me/consent`, `/api/me/suggestions`, `/api/me/export`, `/api/me/erasure-check`.
- `routes/conversations.js`: `DELETE /api/conversations/:id/messages/:messageId`; erasure receipt in the delete responses.
- `app.js`: mounts `/api/me` and lists the new endpoints.
- `scripts/verify-erasure.js` (new): `npm run erasure:verify` (exit code 1 on a failed check).
- `scripts/retention.js` (new): `npm run retention` (`--days`, `--dry-run`).
- `scripts/explain.js`: plans of the lineage, retention, consent and suggestion queries; the two new collections.
- `package.json`: the two new npm scripts.
- `.github/workflows/ci.yml`: runs the erasure verification and a retention dry run on the CI database.
- `tests/consent.test.js`, `tests/erasure.test.js`, `tests/export.test.js`, `tests/retention.test.js` (new): 32 tests.
- `tests/temporal.test.js`: the conversation-delete test now expects erasure (the Stage 2 behaviour "keep and unlink" was replaced on purpose).
- `tests/extraction.test.js`: the consent test uses the real setting instead of a mocked function.
- `tests/users.test.js`, `tests/indexes.test.js`, `tests/helpers.js`: new counts, new indexes, new models.
- `README.md`, `.env.example`: new endpoints, scripts, `RETENTION_SPECIAL_DAYS`, indexes, ER diagram, limitations.
- `docs/PRIVACY.md` (new): feature-by-feature mapping to the DPDP Act 2023 and the GDPR, with gaps.

## 3. Concepts
- **Data lineage / provenance**: recording which source each derived item came from (`sourceMessageIds`), so you can follow it back, and forward when the source is deleted.
- **Hard delete vs soft delete (logical deletion)**: Stage 2's retraction is a soft delete (`retractedAt` set, row kept). Erasure is a hard delete: the document is removed.
- **Cascading delete**: deleting a parent removes dependent rows. MongoDB has no `ON DELETE CASCADE`, so the service layer does it inside a transaction.
- **ACID transaction**: the erasure's many writes commit together or not at all (MongoDB multi-document transactions need a replica set).
- **Anti-join**: "rows of A with NO match in B", written as `$lookup` plus `$match: { hit: { $size: 0 } }`. Used to prove there are no dangling references (referential integrity check).
- **Referential integrity**: every reference points at an existing row; MongoDB does not enforce it, so we check it.
- **Multikey index**: an index on an array field has one entry per array element; `{ userId, sourceMessageIds }` finds every version that lists a message.
- **Partial index**: indexes only the documents matching a filter (`sensitivity: "special"`), so it stays small.
- **TTL index**: MongoDB deletes documents automatically after a date field plus N seconds. Not used here (reasons in Q6).
- **Tombstone**: a placeholder that records that something existed and was deleted, without its content.
- **Append-only log / audit trail**: entries are only inserted; changes to the log are restricted and themselves logged.
- **Doubly linked list repair**: removing a node from a version chain and linking its neighbours (`supersedes` / `supersededBy`).
- **Counterfactual state**: after erasure the current state is what it would be had the erased message never existed (the superseded version is restored).
- **Consent (opt-in / opt-out)**, **withdrawal of consent**, **right to erasure ("right to be forgotten")**, **right of access**, **data portability**, **storage limitation**, **data minimisation**, **special category data**: the legal ideas, mapped in `docs/PRIVACY.md`.

## 4. Examiner questions
1. **How do you find what to erase when a message is deleted?** Every memory version stores the ids of the messages it came from (`sourceMessageIds`). One indexed query on `{ userId, sourceMessageIds }` (multikey) returns every version that lists any deleted message. No text matching is involved, so nothing is missed and nothing unrelated is deleted.
2. **What if a memory came from two messages and only one is deleted?** It is kept, the deleted id is removed from its sources, and it gets an `erasureReview` flag (`GET /api/memories?needsReview=true`), because its text may still contain something from the erased message. We flag rather than re-run the LLM, which would cost money and could change the fact.
3. **What happens to the version chain?** Survivors are linked to each other, skipping erased versions. If the erased version was the current one, the version it superseded becomes current again (its `validTo` is cleared), so the database looks as if the message had never been sent. A version the user had retracted themselves is not brought back.
4. **The audit log is append-only. How can you erase from it?** Two narrowly scoped updates in the model (`tombstone`, `forgetSources`) blank the content of entries about erased versions but keep action, time and actor, and an `erase` entry is appended. So the log still proves *that* an erasure happened (accountability) without keeping *what* was erased (erasure). Normal code paths still cannot update or delete entries.
5. **How do you prove the erasure was complete?** `npm run erasure:verify` runs anti-joins: no memory, audit snapshot, suggestion, job or benchmark label points at a missing message or version. It can also check that specific erased ids appear nowhere and that a phrase (e.g. "penicillin") is in no memory or log snapshot. A test plants leftovers on purpose to show the verifier catches them.
6. **Why a scheduled job for retention and not a TTL index?** A TTL index deletes documents one at a time in the background, outside any transaction and without our code. It would leave version chains pointing at missing versions and the audit log quoting the deleted text, and the period could only be changed with `collMod`. The job reuses the erasure code, so expiry is complete and logged. Cost: someone must schedule it.
7. **What do the three consent modes do?** `store`: the extractor saves facts normally. `ask`: facts become suggestions, invisible to retrieval, until the user accepts (becomes a memory) or rejects (deleted). `never`: the extractor skips them before paying for a reconciliation call, and the API refuses them with 409. Setting `never` also erases what is already stored in that category.
8. **Is the erasure atomic? What if it fails half-way?** Yes. Everything (deletes, relinks, log updates, deleting the message) runs in one MongoDB transaction. A test makes the audit write fail and checks that the message, the memory and the log are unchanged.
9. **Does the export really contain everything?** The test fills every collection for two users and checks that the export's count per collection equals the database's, that the other user's id appears nowhere, and that every Mongoose model in the app has a key in the export, so a future collection cannot be forgotten silently.
10. **Which laws does this map to?** DPDP Act 2023: consent (s.6), erasure on withdrawal or end of purpose (s.8(7)), rights of access (s.11) and erasure (s.12). GDPR: consent and explicit consent for health data (Art. 7, 9), erasure (Art. 17), access and portability (Art. 15, 20), storage limitation (Art. 5(1)(e)). The section numbers are marked `TODO: verify` in `docs/PRIVACY.md` until checked against the official text.

## 5. Weak points
- **The legal mapping was written by an AI and is unverified.** Say so. It is a design map, not legal advice; the section numbers must be checked against the official texts (checklist at the end of `docs/PRIVACY.md`).
- **Default consent is `store`, even for Health.** GDPR Art. 9 wants explicit consent for health data. Answer: the `ask` mode exists; a production default for special categories should be `ask` or `never`. It was kept as `store` so earlier stages' behaviour did not change.
- **Backups, the oplog and the LLM provider are not erased.** A hard delete removes the document, but the replica-set oplog and backups keep it for their retention window, and text sent to the model provider is outside our database. Answer: name the window in a policy; contractually require the processor to erase.
- **Flag, not re-derive.** Answer as in Q2: re-running the LLM costs money and could invent a different fact.
- **Restoring the old version can surprise.** Erasing "moved to Mumbai" makes "lives in Pune" current again, although the user may really have moved. Answer: that is exactly what the database would hold without the erased message; the restored version is flagged for review.
- **Hand-made memories without sources** are not erased with a conversation (no lineage), only unlinked.
- **Retention uses the recording date** and one global period; a fact the user repeats is not "refreshed".
- **Accepting a suggestion does not reconcile** it with similar memories (that would need an LLM call inside an API request), so a duplicate is possible.
- **Erasing all of a large user's data in one transaction** could hit MongoDB's transaction time limit (`transactionLifetimeLimitSeconds`, 60 s by default) and holds locks on many documents. Fine for normal chats; a very large account would need batching.
- **Tests run on the mock LLM only**, which recognises a few sentence patterns. The erasure logic does not depend on the model, but the "ask"/"never" decisions were only exercised with mock extractions.

## 6. Demo on your laptop
Needs MongoDB as a replica set (see `STAGE-2.md`). No API key needed. Run the API in one window and the commands in
a second one.

```powershell
git checkout claude/stage-7-governance   # or main, once merged
npm install
npm test                                  # 299 tests, mock only
npm run seed
$env:WORKER_IN_PROCESS = 'true'; npm start   # window 1: API + extraction worker in one process
```

```powershell
# Window 2: log in as Priya
$base = 'http://localhost:5000'
$login = Invoke-RestMethod -Method Post "$base/api/auth/login" -ContentType 'application/json' -Body '{"email":"priya.nair@example.com","password":"DevPassword123"}'
$h = @{ Authorization = "Bearer $($login.token)" }

# 1. Consent: Hobbies = ask, then look at the settings
Invoke-RestMethod -Method Put "$base/api/me/consent/Hobbies" -Headers $h -ContentType 'application/json' -Body '{"mode":"ask"}'
(Invoke-RestMethod "$base/api/me/consent" -Headers $h).consent | Format-Table category, mode

# 2. Say two things; the worker extracts them within a few seconds
$conv = Invoke-RestMethod -Method Post "$base/api/conversations" -Headers $h -ContentType 'application/json' -Body '{"title":"Demo"}'
$msg = Invoke-RestMethod -Method Post "$base/api/conversations/$($conv._id)/messages" -Headers $h -ContentType 'application/json' -Body '{"role":"user","content":"I am allergic to penicillin"}'
Invoke-RestMethod -Method Post "$base/api/conversations/$($conv._id)/messages" -Headers $h -ContentType 'application/json' -Body '{"role":"user","content":"I love trekking"}'
Start-Sleep 5
(Invoke-RestMethod "$base/api/memories?category=Health" -Headers $h).memories | Format-Table content, sensitivity
(Invoke-RestMethod "$base/api/me/suggestions" -Headers $h).suggestions | Format-Table content   # trekking waits here

# 3. Erase the penicillin message and everything derived from it, then prove it
(Invoke-RestMethod -Method Delete "$base/api/conversations/$($conv._id)/messages/$($msg._id)" -Headers $h).erasure
npm run erasure:verify -- --messages "$($msg._id)" --text penicillin
(Invoke-RestMethod "$base/api/audit?limit=3" -Headers $h).entries | Format-Table action, at, tombstonedAt, reason

# 4. Export everything about Priya
Invoke-WebRequest "$base/api/me/export" -Headers $h -OutFile priya-export.json
(Get-Content priya-export.json | ConvertFrom-Json).counts

# 5. Retention: what would expire after 365 days (dry run: it only counts). On freshly seeded data this is 0,
#    because the seeded facts were recorded less than a year ago; a smaller --days shows non-zero counts
npm run retention -- --days 365 --dry-run
```

Checked in the cloud session against freshly seeded data with the mock LLM: the penicillin memory was erased
(`erasedVersions: 1`, `deletedJobs: 1`), "trekking" waited as a suggestion, the audit log showed `erase` and a
tombstoned `create`, and the verification printed `OK: nothing derived from erased data remains.`

Delete `priya-export.json` afterwards (it is personal data, even if it is sample data) and run `npm run seed` to
reset the database.
