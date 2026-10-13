# Overnight Report

Coordinator log for the unattended run described in `docs/OVERNIGHT_PLAN.md`. Each stage was built by its own
subagent; this file records each subagent's summary, checked against the pushed branch.

Next step: Stage 6-prep (`claude/stage-6-evaluation`, from the Stage 4 branch).

## Stages

| N | Branch | PR | Status | Tests | Blockers / notes |
|---|---|---|---|---|---|
| 2 | `claude/stage-2-temporal-schema` | [#3](https://github.com/PavitranVC/AI-Memory-Organizer/pull/3) | done | 153/153 (9 suites) | None. CI green (Node 20/22, MongoDB 7 and 8). |
| 3 | `claude/stage-3-llm-extraction` | [#4](https://github.com/PavitranVC/AI-Memory-Organizer/pull/4) | done | 193 (153 + 40 new) | Live smoke test not run (no paid calls tonight). |
| 5 | `claude/stage-5-datasets` | [#5](https://github.com/PavitranVC/AI-Memory-Organizer/pull/5) | done (5-lite) | 209 (16 new) | LongMemEval / WildChat not loaded (Hugging Face blocked). |
| 4 | `claude/stage-4-hybrid-retrieval` | [#6](https://github.com/PavitranVC/AI-Memory-Organizer/pull/6) | done (4-lite) | 249 (40 new) | Voyage and Atlas never run (paid / no cluster). Weights untuned. |

## Stage details

### Stage 2: Bi-temporal memory schema
- Head `210b6f5`, verified on `origin`.
- Memories are versioned with valid time and transaction time. An update supersedes the old version inside a
  transaction, `"correction": true` fixes a wrong version, and delete retracts instead of removing.
- New: `?asOf=` / `?knownAt=` on the memory list, `GET /api/memories/:id/history`, `GET /api/audit`
  (append-only `auditlog`), temporal indexes, an idempotent Stage 2 migration, and replica-set MongoDB in CI.
- Not done: MongoDB 8 was not run in the container (Docker Hub returned 429 on the `mongo:8` pull); the CI job
  on MongoDB 8 passed. Out of scope and noted in the PR: the messages query still sorts in memory.

### Stage 3: LLM extraction and reconciliation
- Head `300ec3f`, verified on `origin`. Stacked on #3.
- `services/llm/` with a Claude provider (structured outputs, cached system prompt) and a deterministic mock.
  Prompts versioned in `prompts/*.md`; every call logged in `llmcalls` with tokens, cache-read/write tokens,
  latency and cost.
- Posting a message saves the message and its extraction job in one transaction; a worker decides
  ADD / UPDATE / SUPERSEDE / NOOP through the Stage 2 memory service. The extractor sees the new message plus
  6 recent messages.
- New: `GET /api/jobs`, `GET /api/jobs/:id`, `npm run worker`, `npm run llm:costs`, `npm run test:live`.
- Not done: the live smoke test (overnight rule). The Claude provider is tested only with a fake SDK client.
  The live-test cost is a **projection** from character counts (about $0.41 expected, $1.96 worst case), in
  `results/stage3-live-cost-estimate.txt`.
- Noted in the PR, not fixed: the messages index has no `_id` tie-break (small in-memory sort); `npm audit`
  reports existing advisories.

### Stage 5-lite: Real datasets
- Head `55251e7`, verified on `origin`. Stacked on #4.
- `dataset` label and original-id `source` on users, conversations, messages and memories; new `evalitems`
  collection for LoCoMo QA.
- New: `npm run data:download`, `data:load:locomo`, `data:synthetic` (seeded), `data:stats`.
- Real LoCoMo load (`benchmark`): 10 users, 272 conversations, 5,882 messages, 1,986 questions, 3 evidence ids
  unmatched. Reload is idempotent. Synthetic: 10k memories in 0.7 s, 100k in 7.3 s. Recorded in
  `results/stage5-*`.
- Not done: LongMemEval and WildChat (huggingface.co blocked, no loaders, nothing tested; the LongMemEval URL is
  `TODO: verify`). Skipped per plan: PII scrubbing, sampler, annotation tool and guidelines, kappa script.
- LoCoMo question-type names were checked against the data, not the authors' code (`TODO: verify`).
- Note for Stage 6: LoCoMo's second speaker is stored as `assistant`, and the extractor only reads `user`
  messages.

### Stage 4-lite: Hybrid retrieval
- Head `406e478`, verified on `origin`. Stacked on #5.
- Embedding stored on each memory version; providers: mock, lexical (a lexical baseline, **not** a semantic
  model) and Voyage. Local (brute-force cosine) and Atlas vector backends behind one interface; weights in
  `.env`; only memories valid at `asOf` are returned.
- `POST /api/ask` sends only the top-k memories to the model and checks the answer's citations;
  `GET /api/memories/retrieve` shows the ranking without the model. Reconciliation now uses hybrid retrieval.
- Benchmark (`synthetic`, one user, lexical embedder): p95 50.39 ms at 1k memories, 322.24 ms at 10k
  (`results/stage4-retrieval-latency.csv`). The vector is about 82% of each memory document's size.
- Not done: Voyage never called (request format `TODO: verify`); Atlas `$vectorSearch` never run, only checked
  against a test emulator (null filters `TODO: verify`). Weights, 90-day half-life and lexical cut-off 0.3 are
  untuned.
- Known weakness: recency counts from `validFrom`, so a long-standing current fact ranks low (in the notes).

## Needs you
- Stage 2: convert your laptop MongoDB service to a replica set (`docs/stages/STAGE-2.md`, section 6), then run
  `npm test` and `npm run migrate` locally.
- Stage 3: with `ANTHROPIC_API_KEY` in `.env`, run `npm run test:live` (projected about $0.41). It writes
  `results/stage3-live-smoke-<date>.json`.
- Stage 5: accept LoCoMo's CC BY-NC 4.0 licence. To get LongMemEval / WildChat, allow Hugging Face in the
  environment's network settings or download them on your laptop.
- Stage 5: verify the LoCoMo question-type names and the LongMemEval URL (marked `TODO: verify`).
- Stage 4 (optional): real embeddings with `VOYAGE_API_KEY` + `EMBEDDING_PROVIDER=voyage` (allow
  api.voyageai.com), then `npm run embed:backfill`; or an Atlas M0 cluster with `VECTOR_BACKEND=atlas` and
  `npm run atlas:index` (steps in the README).
