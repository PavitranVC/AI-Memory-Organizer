# Stage 3: LLM extraction and reconciliation (viva notes)

Pull request: "Stage 3: LLM extraction and reconciliation" into `main`. It is **stacked on the Stage 2 PR**
(#3): merge Stage 2 first, then this one.

## 1. In one paragraph
Until Stage 2 every memory had to be typed in by hand through `POST /api/memories`. Stage 3 makes the system build
its memory **from the conversation itself**. When the user posts a message, the API saves it and queues a job in
the same transaction, then answers at once. A **worker** picks the job up and asks an LLM two questions: first
"which durable facts about the user does this message state?" (**extraction**), then, for each fact, "is this new,
a more precise version of something we know, a change in the world, or nothing new?" (**reconciliation**: ADD,
UPDATE, SUPERSEDE or NOOP). The decision is written through the Stage 2 service, so every automatic change is a
proper version with valid time, provenance (`sourceMessageIds`) and an audit entry marked `via: "extractor"`.
Every LLM call is logged (tokens, prompt-cache reads, latency, cost) for the cost analysis in Stage 6. The LLM sits
behind a provider interface: a deterministic **mock** (the default, used by every test, free) and **Claude** via
the official SDK. This is the step that turns the bi-temporal database into an actual *AI memory*: the
SUPERSEDE decision is what fills the version chains that the thesis evaluates.

## 2. What changed
| File | Why |
|---|---|
| `services/llm/index.js` | `callLlm()`: the single entry point for every LLM call. Picks the provider, fills the versioned prompt, logs the call to `llmcalls` |
| `services/llm/config.js` | Reads `LLM_PROVIDER`, `EXTRACTION_MODEL`, `RECONCILE_MODEL`, `JUDGE_MODEL` (default `claude-opus-5-5`), `LLM_EFFORT`, `LLM_FALLBACKS` from the environment |
| `services/llm/anthropicProvider.js` | Claude through `@anthropic-ai/sdk`: structured outputs (JSON schema), cached system prompt, refusal and `max_tokens` handling, retryable vs non-retryable errors |
| `services/llm/mockProvider.js` | Deterministic test double: a few sentence patterns for extraction, simple rules for reconciliation; `[mock:fail]` / `[mock:refuse]` simulate errors in tests |
| `services/llm/prompts.js` | Loads `prompts/<task>.vN.md`, splits the stable system part from the per-call user template, hashes the text |
| `services/llm/schemas.js` | JSON schemas sent to the API, and validators that re-check every answer (ranges, enums, and that a decision only targets a memory the model was shown) |
| `services/llm/pricing.js` | $ per million tokens (input, output, cache read, cache write) to compute the cost of each call |
| `services/llm/errors.js` | `LlmError` (with `retryable`) and `LlmRefusalError` |
| `prompts/extract.v1.md`, `prompts/reconcile.v1.md` | The two prompts, versioned. Stable instructions first (cacheable), per-call data last |
| `services/extractionService.js` | The pipeline for one message: recent window, extract, validate, consent check, find similar memories (text index), reconcile, apply through `memoryService` |
| `services/jobService.js` | The job queue: enqueue (inside the message transaction), atomic claim, complete, retry with exponential back-off, recover jobs of a dead worker; `GET /api/jobs` logic |
| `services/worker.js` | Runs jobs: `runOnce`, `drain` (tests, `--drain`), and a polling loop |
| `services/consentService.js` | The consent hook (allows everything now; Stage 7 fills it in) |
| `models/Job.js` | `jobs` collection: status, attempts, `runAt`, lock fields, error, result. Indexes for claiming and recovery |
| `models/LlmCall.js` | `llmcalls` collection: model, served model, prompt id and hash, tokens (input, output, cache read, cache write), latency, cost, status. No prompt text is stored |
| `models/AuditLog.js`, `services/auditService.js` | Two new fields: `via` (`api` or `extractor`) and `reason` (the reconciler's reason) |
| `services/memoryService.js` | `createMemory` / `updateMemory` take an optional actor (`actorId: null, via: 'extractor'`), so the extractor reuses the exact Stage 2 write path |
| `services/conversationService.js` | `createMessage` saves the message and its job in one transaction (returns `extractionJobId`); deleting a conversation deletes its jobs |
| `services/userService.js` | Deleting an account also deletes its jobs and LLM call log |
| `routes/jobs.js`, `app.js` | `GET /api/jobs`, `GET /api/jobs/:id` (own jobs only) |
| `index.js` | Builds the new indexes; `WORKER_IN_PROCESS=true` runs the worker inside `npm start` |
| `scripts/worker.js` | `npm run worker` (loop) and `npm run worker -- --drain` |
| `scripts/live-smoke.js`, `scripts/fixtures/live-conversations.js` | `npm run test:live`: cost estimate, then (only with a key) a real run on 3 synthetic conversations, results saved to `results/` |
| `scripts/llm-costs.js` | `npm run llm:costs`: an aggregation over `llmcalls` (tokens, cache hit rate, cost per model/task/prompt) |
| `scripts/explain.js`, `seed.js` | Know the two new collections; explain checks the claim query and the new lists |
| `results/stage3-live-cost-estimate.txt` | The cost estimate of the live test, with command, commit, date and dataset (a projection, not a measurement) |
| `tests/llm.test.js` | 20 unit tests: config, prompts, pricing, validators, mock, and the Anthropic provider with a fake SDK client (request shape, refusal, errors) |
| `tests/extraction.test.js` | 20 tests against real MongoDB: queuing, ADD / UPDATE / SUPERSEDE / NOOP, skipping, user isolation, context window, retries, refusals, atomic claim, dead-worker recovery, `GET /api/jobs` |
| `tests/helpers.js`, `tests/setupEnv.js`, `tests/users.test.js` | Clear the new collections; force the mock and remove any key in tests; account deletion now reports jobs and LLM calls |
| `.github/workflows/ci.yml` | CI also runs the worker once and the live test without a key (it must skip) |
| `package.json` | `@anthropic-ai/sdk`; scripts `worker`, `test:live`, `llm:costs` |
| `README.md`, `.env.example` | Pipeline diagram, provider switch, new endpoints, variables, indexes, limitations |

## 3. Concepts
| Idea | Textbook name | One line |
|---|---|---|
| Message and job saved in one transaction | **Transactional outbox** | The "something must happen later" record is written atomically with the data, so neither exists without the other |
| The API answers before the LLM runs | **Asynchronous processing / producer-consumer queue** | The request thread only enqueues; a separate consumer does the slow work |
| `findOneAndUpdate` pending -> running | **Atomic claim (compare-and-set)** | The status check and the change are one operation, so two workers can never take the same job |
| A job may run twice after a crash | **At-least-once delivery + idempotent consumer** | Retries are safe because facts already stored from the same message are skipped |
| Waiting longer after each failure | **Exponential back-off** | Retry delay doubles (5 s, 10 s, ...), so a rate-limited API is not hammered |
| Dead worker's job is taken back | **Lease / lock timeout** | A claim expires after `JOB_LOCK_TIMEOUT_MS`, then the job is pending again |
| Message -> facts | **Information extraction** (here: LLM-based) | Turning free text into structured records |
| ADD / UPDATE / SUPERSEDE / NOOP | **Entity resolution + belief revision** | Decide whether a new fact matches an existing one and how the stored beliefs change |
| SUPERSEDE vs UPDATE | **Valid-time update vs correction** (bi-temporal) | The world changed (old version closes) vs our record was imprecise (old version retracted) |
| `sourceMessageIds` on every extracted memory | **Data provenance (lineage)** | Each fact points to the message it came from; Stage 7 uses it for erasure |
| JSON schema in the request | **Structured output / constrained decoding** | The model can only answer in the declared shape |
| Re-validating the answer anyway | **Defence in depth / input validation** | Model output is untrusted input to the database |
| Decision may only target a shown memory | **Least privilege / tenant isolation** | The model can never point the write at another user's data |
| Stable prompt first, `cache_control` | **Prompt caching (prefix caching)** | An identical prefix is reused at a fraction of the input price |
| Only the new message + 6 earlier ones | **Context windowing** | Input cost grows with the text sent, so send what the decision needs |
| No LLM call when nothing is similar | **Short-circuit evaluation** | Skip the expensive step when its answer is known |
| `prompts/extract.v1.md` + hash | **Versioning / reproducibility** | Every logged call says which prompt wording produced it |
| `llmcalls` + `npm run llm:costs` | **Observability / cost accounting** with `$group` aggregation | Per-call metrics, summed per model, task and prompt |
| Mock provider | **Test double (fake)** and **dependency injection** | Tests are deterministic, free and need no key |

## 4. Examiner questions
1. **Why not call the LLM inside the POST request?**
   An LLM call takes seconds and can fail or be rate-limited. The user should not wait for it, and a failure must
   not lose the message. So the request only saves the message and a job; the worker does the LLM work and retries.
2. **What happens if the server crashes right after saving the message?**
   The message and its job are written in one transaction, so either both exist or neither. If the job exists,
   the worker will process it later. This is the transactional outbox pattern.
3. **What if the worker crashes in the middle of a job?**
   The job stays `running` with a `lockedAt` time. After the lock timeout it is put back to `pending` (or `failed`
   if it used all 3 attempts). On the rerun, facts already stored from that message are skipped, so nothing is
   stored twice.
4. **Can two workers process the same job?**
   No. Claiming is one `findOneAndUpdate({status: 'pending', runAt <= now}, {status: 'running', ...})`. MongoDB
   applies it atomically to one document, so only one worker sees `pending`. A test fires three claims at once
   and exactly one succeeds.
5. **What is the difference between UPDATE and SUPERSEDE?**
   SUPERSEDE: the old fact *was* true and stopped ("lived in Pune", now "lives in Mumbai"); the old version stays
   believed but its valid time ends. UPDATE: the same fact said more precisely ("likes coffee" -> "likes black
   coffee"); it is a correction, so the old version is retracted and the new one takes over its valid time.
6. **How do you stop the LLM from inventing data or touching another user's memories?**
   The answer must match a JSON schema, and it is validated again in code (ranges, enums). For reconciliation the
   model only sees the user's own memories, and a decision whose `targetMemoryId` is not one of them is rejected.
   A test simulates a malicious answer and checks the other user's memory is unchanged.
7. **How do you measure cost?**
   Every call writes a row in `llmcalls` with input, output, cache-read and cache-write tokens, latency and the
   cost from the price table. `npm run llm:costs` sums them with an aggregation. Mock rows are marked as estimated
   and cost 0, so they are never mistaken for real usage.
8. **What is prompt caching and how is it used here?**
   The API can reuse the processed form of an identical prompt prefix at a lower price. Each prompt keeps its long,
   stable instructions first (marked with `cache_control`) and the per-call data last, so from the second call the
   instructions are read from the cache. `cacheReadTokens` in `llmcalls` shows whether it worked; it has not been
   measured yet because no live call was made.
9. **Why is the mock not a baseline?**
   It is a set of regular expressions written to exercise the pipeline in tests. It says nothing about extraction
   quality, so its outputs are never reported as results. Only Claude runs count, and they are evaluated in Stage 6.
10. **How do you find "similar" memories, and what is its weakness?**
    The MongoDB text index on content and tags, inside the user's current memories, top 5 by text score. It matches
    words, not meaning, so "nut allergy" will not find "allergic to peanuts". Stage 4 adds vector search for that.

## 5. Weak points
- **No live run with Claude.** The tests use the mock, and the Claude provider is only tested against a fake SDK
  client (request shape, refusal, errors). The pipeline has since run on real local models (Stage 3b,
  `LLM_PROVIDER=ollama npm run test:live`); see `STAGE-3B.md`. The Claude estimate is in
  `results/stage3-live-cost-estimate.txt`.
- **Since Stage 3b the active extraction prompt is `extract.v2`** (dated events and plans as well as lasting facts).
  Everything in this note about `extract.v1` describes Stage 3 as built.
- **The cost estimate is a projection.** Token counts are characters/4 x 1.35, and thinking tokens are assumed
  (1,500 per extraction, 800 per reconciliation). The live run replaces it with measured figures.
- **Keyword similarity.** Related facts with no shared words are missed, which can create near-duplicates. Fixed by
  hybrid retrieval in Stage 4.
- **The mock only knows a few patterns** and relies on the `topic` tag; seeded memories (Stage 2 data) have no topic
  tags, so with the mock a new fact about them is ADDed instead of superseding. The real model reads the content.
- **One job at a time.** Safe, but slow if many messages arrive; two facts of the same user are never reconciled in
  parallel (that would race). Scaling out would need per-user ordering.
- **The extractor decides alone.** There is no human review of SUPERSEDE decisions; mistakes are visible in the
  audit log (`via: "extractor"`, with the reason) and can be corrected through the API.
- **Valid time from the model.** If the model returns a wrong `validFrom`, the history is wrong. Stated dates
  after the message are ignored, and a SUPERSEDE start that is not after the old version falls back to the
  message time.
- **Consent is a stub** until Stage 7. The hook is already called for every fact.
- **Pricing is a hard-coded table** (checked 2026-10-12). Unknown models get `costUsd: null`, never $0.
- **Unrelated, not fixed here:** the messages index `{ conversationId, sentAt }` has no `_id`, so reading messages
  in `(sentAt, _id)` order uses a small in-memory sort (visible in `npm run explain`).

## 6. Demo on your laptop
The outputs below are from the default mock LLM (`LLM_PROVIDER` unset or `mock`). With `LLM_PROVIDER=ollama` a real
model decides, so the memories, decisions and timing differ, and each step takes longer.
Needs MongoDB running as a replica set (see `STAGE-2.md`).

```powershell
git checkout claude/stage-3-llm-extraction   # or main, once merged
npm install
npm test                  # all pass; 323 tests on main since Stage 3b (mock only, no key)
npm run seed
npm run explain           # includes "jobs: claim the oldest due job" -> IXSCAN(status_1_runAt_1)
$env:WORKER_IN_PROCESS = 'true'; npm start   # API + worker in one window (mock LLM)
```

Second PowerShell window (a fresh user, so the history is easy to read):
```powershell
$b = 'http://localhost:5000'
$reg = Invoke-RestMethod -Method Post -Uri "$b/api/auth/register" -ContentType 'application/json' -Body '{"name":"Demo","email":"demo3@example.com","password":"DemoPass123"}'
$h = @{ Authorization = "Bearer $($reg.token)" }
$c = Invoke-RestMethod -Method Post -Uri "$b/api/conversations" -Headers $h -ContentType 'application/json' -Body '{"title":"Demo"}'
$say = { param($t) Invoke-RestMethod -Method Post -Uri "$b/api/conversations/$($c._id)/messages" -Headers $h -ContentType 'application/json' -Body (@{ role = 'user'; content = $t } | ConvertTo-Json) }

& $say 'I live in Pune since 2020 and I am allergic to peanuts'   # returns at once with extractionJobId
Start-Sleep 3
Invoke-RestMethod "$b/api/memories" -Headers $h | Select-Object -ExpandProperty memories | Format-Table content, validFrom, sensitivity

& $say 'Big news: I moved to Mumbai in March 2025'               # SUPERSEDE
Start-Sleep 3
(Invoke-RestMethod "$b/api/jobs?limit=1" -Headers $h).jobs[0].result.decisions | Format-Table action, topic, reason
$m = (Invoke-RestMethod "$b/api/memories?category=Personal" -Headers $h).memories[0]
(Invoke-RestMethod "$b/api/memories/$($m._id)/history" -Headers $h).versions | Format-Table content, validFrom, validTo
Invoke-RestMethod "$b/api/memories?asOf=2024-01-01" -Headers $h | Select-Object -ExpandProperty memories | Format-Table content

& $say 'As I said, I live in Mumbai'                              # NOOP: nothing new is written
Start-Sleep 3
(Invoke-RestMethod "$b/api/jobs?limit=1" -Headers $h).jobs[0].result.decisions | Format-Table action, reason
Invoke-RestMethod "$b/api/audit?limit=5" -Headers $h | Select-Object -ExpandProperty entries | Format-Table action, via, reason
```

Back in the first window (stop the server with Ctrl+C first, or use a third window):
```powershell
npm run llm:costs -- --include-mock   # mock rows: estimated tokens, $0
npm run test:live -- --estimate        # the cost estimate, no API call
```

With your API key (costs a little money; see the estimate first). Put `ANTHROPIC_API_KEY=...` in `.env`, then:
```powershell
npm run test:live                      # 3 conversations, prints real tokens, cache reads and cost, saves results/stage3-live-smoke-<date>.json
$env:LLM_PROVIDER = 'anthropic'; npm start   # now the worker uses Claude; inspect memories, auditlog and llmcalls in Compass
```
