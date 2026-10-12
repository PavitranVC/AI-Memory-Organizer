# Overnight Report

Coordinator log for the unattended run described in `docs/OVERNIGHT_PLAN.md`. Each stage was built by its own
subagent; this file records each subagent's summary, checked against the pushed branch.

Next step: Stage 5-lite (`claude/stage-5-datasets`, from the Stage 3 branch).

## Stages

| N | Branch | PR | Status | Tests | Blockers / notes |
|---|---|---|---|---|---|
| 2 | `claude/stage-2-temporal-schema` | [#3](https://github.com/PavitranVC/AI-Memory-Organizer/pull/3) | done | 153/153 (9 suites) | None. CI green (Node 20/22, MongoDB 7 and 8). |
| 3 | `claude/stage-3-llm-extraction` | [#4](https://github.com/PavitranVC/AI-Memory-Organizer/pull/4) | done | 193 (153 + 40 new) | Live smoke test not run (no paid calls tonight). |

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

## Needs you
- Stage 2: convert your laptop MongoDB service to a replica set (`docs/stages/STAGE-2.md`, section 6), then run
  `npm test` and `npm run migrate` locally.
- Stage 3: with `ANTHROPIC_API_KEY` in `.env`, run `npm run test:live` (projected about $0.41). It writes
  `results/stage3-live-smoke-<date>.json`.
