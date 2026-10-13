# AI Memory Organizer: Roadmap

Goal: turn the DBMS-review prototype into a research-grade project:

> **Thesis.** AI-assistant memory is a database problem. Storing memories
> bi-temporally (when a fact was true vs. when it was recorded), with
> provenance back to the source messages, improves answer accuracy on
> knowledge-update and temporal questions compared with overwrite-style
> memory, at a measurable storage and latency cost, and makes user-governed
> erasure exact.

Every stage is a separate branch with its own pull request. The copy-paste
prompt, the steps to do before running it, and the model and effort to use
for each stage are in [`PROMPTS.md`](PROMPTS.md). To build several stages in one unattended run, see
[`OVERNIGHT_PLAN.md`](OVERNIGHT_PLAN.md). Each stage leaves
the app runnable and the tests green.

---

## Branching model

| Stage | Branch | Depends on |
|---|---|---|
| 0. Plan (this document, `CLAUDE.md`) | `claude/laughing-lamport-d9jmok` | `main` |
| 1. Database hardening | `claude/stage-1-db-hardening` | 0 |
| 2. Bi-temporal memory schema | `claude/stage-2-temporal-schema` | 1 |
| 3. LLM extraction + reconciliation | `claude/stage-3-llm-extraction` | 2 |
| 3b. Local AI with Ollama + study commands | `claude/stage-3b-ollama` | 3 (built on `main` after 7) |
| 4. Hybrid retrieval | `claude/stage-4-hybrid-retrieval` | 3 |
| 5. Real datasets + loaders | `claude/stage-5-datasets` | 2 (can run alongside 3–4) |
| 6. Evaluation harness + benchmarks | `claude/stage-6-evaluation` | 4, 5 |
| 7. Privacy and governance | `claude/stage-7-governance` | 2 |
| 8. Demo UI (optional) | `claude/stage-8-ui` | 4 |
| 9. Paper and review documents | `claude/stage-9-paper` | 6 |

Rules:
- A stage branches from `main` once the stage it depends on is merged.
  Otherwise it branches from that stage's branch (stacked), so work never
  waits on a merge.
- Merge into `main` in stage order. A stacked branch is updated by merging
  (no rebase or force-push) after its parent merges.
- Nobody pushes directly to `main`.

---

## Stage details

### Stage 1: Database hardening (fixes the review weak points)
- Referential integrity: check that `userId`, `categoryId` and
  `conversationId` exist on create and update. Cascade or block deletes of
  users, categories and conversations.
- Scope every query to a user (simple JWT auth). Remove the unscoped
  `GET /api/memories` and the cross-user `/search`.
- Index review: drop `userId_1` (a prefix of the compound index) and the
  standalone `status_1` (low cardinality). Follow the equality, sort, range
  (ESR) rule.
- Pagination (`limit` plus cursor) on every list endpoint.
- CRUD routes for users, categories and conversations. Move messages out of
  the unbounded embedded array (separate `messages` collection or the bucket
  pattern).
- Commit a fixed `scripts/explain.js`, replacing the uncommitted `test-db.js`
  that printed duplicate index names.
- Jest and supertest tests against a real MongoDB. GitHub Actions CI with a
  MongoDB service container.
- README with setup instructions, an ER/schema diagram and the API reference.

### Stage 2: Bi-temporal memory schema
- New `Memory` fields:
  - valid time: `validFrom`, `validTo`
  - transaction time: `recordedAt`, `retractedAt`
  - provenance and scoring: `sourceMessageIds`, `confidence`,
    `sensitivity` (`normal` / `personal` / `special`)
  - version chain: `supersedes`, `supersededBy`
  - usage: `lastAccessedAt`, `accessCount`
- Updates become SUPERSEDE (close the old version, insert a new one) instead
  of overwriting in place.
- "As-of" queries: what did we believe about the user at time T?
- `auditlog` collection: append-only record of every create, supersede and
  delete.
- A migration script for existing data, plus indexes for the temporal
  queries.

### Stage 3: LLM extraction and reconciliation
- `services/llm/`: a provider interface with a Claude implementation and a
  deterministic **mock** provider (used by tests, so CI never needs a key).
- Extraction: conversation turn → candidate facts with category, importance,
  confidence and sensitivity.
- Reconciliation: each candidate is compared with similar existing memories
  and becomes ADD / UPDATE / SUPERSEDE / NOOP.
- Adding a message to a conversation triggers extraction, asynchronously.
- Prompts are versioned in `prompts/`, and every LLM call is logged
  (tokens, latency) for the cost analysis.

### Stage 3b: Local AI with Ollama + study commands
- An Ollama LLM provider (`LLM_PROVIDER=ollama`) and an Ollama embedding provider (`EMBEDDING_PROVIDER=ollama`),
  behind the existing interfaces, so no real run needs a paid API key. A different model judges the evaluation.
- The evaluation records seconds per item and projects the run time of the full benchmark from a pilot.
- Claude Code study commands: `/viva <stage>` and `/sync-docs`. Notes: `docs/stages/STAGE-3B.md`.

### Stage 4: Hybrid retrieval
- Embeddings stored on each memory, behind a pluggable embedding provider.
- Vector search: MongoDB Atlas `$vectorSearch` when available, with a
  brute-force cosine fallback for local development and tests.
- Hybrid ranking: text score + vector similarity + recency + importance,
  filtered by validity at the query time.
- `POST /api/ask`: retrieve memories and answer with citations to the
  memories used.

### Stage 5: Real datasets
- Loaders, each turning a dataset into users, conversations and messages:
  - **LoCoMo** (`snap-research/locomo`): downloadable from this environment.
  - **LongMemEval** (Hugging Face): blocked here, so the user downloads it
    or the network policy is changed.
  - **WildChat** (Hugging Face): same as LongMemEval.
- PII scrubbing before anything from WildChat is stored.
- Annotation tool and guidelines. Humans label which facts in sampled
  WildChat conversations should be remembered; this becomes the project's
  original dataset.
- Scale generator for the index experiments (10k / 100k / 1M memories),
  clearly labelled **synthetic** and used only for performance numbers.

### Stage 6: Evaluation
- Systems compared:
  1. full context
  2. plain RAG over raw messages
  3. overwrite-style memory
  4. ours
  5. ablations: ours without the temporal model, ours without provenance
- Metrics:
  - QA accuracy per question type (LLM judge, plus human spot-checks)
  - retrieval recall@k
  - p50/p95 latency
  - storage
  - tokens and cost
- Index benchmarks: `explain("executionStats")` before and after at each
  scale.
- All results are written to `results/` as CSV, with the exact command and
  git commit that produced them. Charts are generated from those CSVs.

### Stage 7: Privacy and governance
- Per-category consent (e.g. "never store health facts").
- Lineage-based erasure: deleting a conversation removes every memory
  derived from it, and the erasure is verified.
- Export of all data stored about a user.
- Retention policies for `special`-sensitivity memories.
- A mapping of each feature to India's DPDP Act 2023 and to GDPR (Art. 9 and
  Art. 17).

### Stage 8: Demo UI (optional)
- Small React app: chat, a memory timeline showing superseded versions, an
  "as-of" slider, and a consent and erasure panel.

### Stage 9: Paper and review documents
- Draft of the paper sections:
  - problem
  - related work: Mem0, MemGPT/Letta, Zep/Graphiti, A-Mem, LangMem
  - design
  - evaluation
  - limitations
- Review-3 document (.docx) built from the real results.
- Every claim in these documents must trace to a file in `results/`.

---

## Who does what

### The student team (only you can do these)
1. **Review and merge** each stage PR in order. Pull it, run `npm install`,
   `npm test`, `npm run seed` and `npm start` locally, and make sure you can
   explain every change. You will be asked about it in the viva.
2. **Check your course's AI-assistance policy** with your guide, and
   disclose the use of AI tools as it requires.
3. **Stage 3+: provide an LLM API key** as a secret in the Claude Code
   environment settings, never pasted into chat or committed. Set a
   spending limit on the provider console.
4. **Stage 4: create a free MongoDB Atlas (M0) cluster** if you want real
   vector search, and add its connection string as a secret. Also allow
   `*.mongodb.net` in the environment's network policy.
5. **Stage 5: get the Hugging Face datasets.** Either allow `huggingface.co`
   in the environment's network policy, or download LongMemEval and WildChat
   yourselves and run the loaders locally. Accept any dataset license or
   usage agreement yourselves.
6. **Human annotation.** Label the WildChat sample using the provided
   guidelines. Labels pre-filled by a model are marked as such and are not
   counted as human labels.
7. **User study (optional).** Get ethics committee approval before
   collecting anyone's chat data, and collect signed consent.
8. **Final screenshots and demo** run on your own machine.

### Claude (see `CLAUDE.md` for the working rules)
- Writes all code, tests, migrations, CI, data loaders, benchmark scripts,
  charts and documentation, one stage branch at a time.
- Runs a real MongoDB (Docker) inside the session, so tests and index
  benchmarks are executed, not just written.
- Opens a PR per stage when asked, and fixes CI and review comments on it.
- Drafts the paper sections, annotation guidelines, consent form and review
  document from real results only.
