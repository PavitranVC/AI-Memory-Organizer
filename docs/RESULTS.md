# Results (Stage 6)

What has been measured so far, how, and what it does **not** show. Every number below is copied from a CSV in
`results/`, which records the command, git commit, date and dataset that produced it. Charts are drawn only from
those CSVs (`node eval/charts.js ...`).

| What | Status | Files |
|---|---|---|
| Index benchmark (DBMS experiment) | **Measured** on 10k, 100k and 1M **synthetic** memories | `results/stage6-index-bench*.csv`, `.txt`, `.svg` |
| QA evaluation on LoCoMo (6 systems) | **Not run with a real model yet.** Only a pipeline check on the mock model | `results/stage6-pipeline-check-mock-2026-10-12/` |
| Cost of the paid LoCoMo run | **Projection**, not a measurement | `results/stage6-cost-projection.csv`, `.txt` |
| LongMemEval, extraction precision/recall | Not done (Hugging Face blocked; no human gold set yet) | - |

## 1. Index benchmark: the main queries with and without indexes

**Question:** how much do the secondary indexes of `models/Memory.js` matter for the app's real queries as the
collection grows, and what do they cost?

**Method** (`npm run bench:indexes`, `eval/bench-indexes.js`, commit `d3ab957`, 2026-10-12):
- Dataset: **synthetic** memories from `services/datasets/synthetic.js` (seed 42, 1 user per 1,000 memories, about
  78% current versions, 20% superseded, 2% retracted). Used for performance only, never for accuracy.
- For each size, a fresh database with only the `_id` index; each query is run with `explain("executionStats")`
  on 5 parameter sets (random user, category and time) and timed 30 times after 3 warm-up runs. Then the schema's
  indexes are built one by one (timed) and everything is run again.
- Wall-clock is measured in Node (query + network + decoding), percentiles by nearest rank.
- One run on one machine (4 vCPU, 16 GB RAM, MongoDB 7.0 in Docker on the same machine), warm cache: the largest
  collection (460 MB of data) is far smaller than MongoDB's cache (7.9 GB).

**p50 latency in ms** (`results/stage6-index-bench.csv`; "no" = only `_id`, "yes" = the schema's indexes):

| Query | 10k no | 10k yes | 100k no | 100k yes | 1M no | 1M yes | 1M docs examined (no / yes) |
|---|---|---|---|---|---|---|---|
| current, newest first | 2.09 | 1.76 | 6.73 | 1.45 | 75.88 | 1.38 | 25,831 / 26 |
| current, by status | 1.96 | 1.44 | 7.6 | 1.47 | 91.31 | 1.3 | 28,078 / 28 |
| current, by category | 3.18 | 1.51 | 22.96 | 1.37 | 280.11 | 1.48 | 99,857 / 21 |
| asOf (valid time) | 10.19 | 2.4 | 151.16 | 2.46 | 1421.34 | 2.05 | 557,620 / 22 |
| knownAt (transaction time) | 10.53 | 2.16 | 118.46 | 2.29 | 1386.82 | 2.22 | 557,631 / 22 |
| asOf + knownAt (bi-temporal) | 12.22 | 2.41 | 112.2 | 2.1 | 1653.79 | 2.21 | 557,620 / 22 |
| history hop (version by `_id`) | 1.13 | 1.17 | 1.09 | 1.09 | 1.17 | 0.9 | 1 / 1 |
| all current rows of a user (vector scan) | 8.5 | 3.66 | 54.17 | 3.22 | 517.7 | 3.23 | 1,000,000 / 0 |
| keyword search, current | cannot run | 2.12 | cannot run | 2.32 | cannot run | 2.02 | - / 119 |
| category in use? (delete check) | 1.38 | 1.09 | 1.14 | 1.01 | 0.98 | 0.99 | 2 / 1 |
| aggregate: count by category | 7.16 | 2.66 | 52.12 | 3.22 | 523.68 | 2.86 | 1,000,000 / 779 |

![p50 latency, with and without indexes](../results/stage6-index-bench-p50.svg)
![documents examined, with and without indexes](../results/stage6-index-bench-docs.svg)

**Cost of the indexes** (`results/stage6-index-bench-build.csv`):

| Memories | Data | Secondary indexes | Index build (all) | Insert 10k versions, no index | Insert 10k, indexed |
|---|---|---|---|---|---|
| 10k | 4.6 MB | 1.9 MB | 0.91 s | 0.172 s | 0.608 s |
| 100k | 46.0 MB | 17.9 MB | 2.82 s | 0.28 s | 0.579 s |
| 1M | 459.9 MB | 176.7 MB | 25.49 s | 0.211 s | 0.604 s |

**What it shows**
- Without indexes, the user-scoped queries get slower roughly in proportion to the collection (the plan reads
  more documents), while with indexes they stay at 1-3 ms from 10k to 1M, because they read about as many index
  keys and documents as they return (21-28 for a page of 21).
- The temporal queries suffer most without indexes (over 1.4 s at 1M): their range conditions match few rows, so
  the `_id` walk reads more than half the collection before it finds a page.
- The "vector scan" query becomes a **covered** query with the index (0 documents examined): the index alone
  answers it.
- The price: the secondary indexes are about 38-42% of the data size, and inserting 10,000 versions took 2 to 3.5
  times longer with them (about 0.6 s instead of 0.17-0.28 s).

**What it does not show (limitations)**
- Synthetic data and a single run on one machine, with a warm cache and MongoDB on the same machine. No
  confidence intervals for these timings; repeat the run on your laptop before quoting a small difference.
- Small differences (for example 1.38 vs 1.76 ms) are within the noise of one run.
- Without indexes the planner did **not** always do a COLLSCAN: for "newest first" queries it walked the `_id`
  index backwards (sorted by `_id`) and filtered. The docs-examined column is the fairer comparison.
- "category in use?" is fast without an index only because every category is used, so the scan stops after
  1-2 documents. An unused category would scan the whole collection.
- The synthetic memories have no embedding vectors (about 460 bytes each). Real memories with the lexical vector
  are about 2.4 KB larger (Stage 4), which would make the scans without indexes slower still.
- `storageSize` for 10k is 4 KB because WiredTiger had not written the new collection to disk yet; `data_bytes`
  (the uncompressed size) is the reliable column.

## 2. QA evaluation on LoCoMo: the harness (not yet a result)

**Systems** (`eval/systems.js`), all answering with the same prompt (`prompts/eval-answer.v1.md`) and model, so only
the context differs:

| System | Context given to the answer model |
|---|---|
| `full_context` | The whole conversation (all sessions), cached across the sample's questions |
| `rag_messages` | The k raw messages most similar to the question (embedding cosine) |
| `overwrite_memory` | k memories from a store where an UPDATE or SUPERSEDE rewrites the memory in place (no history) |
| `ours` | k current memories at the question date, with `validFrom`/`validTo` and a quote of the source message |
| `ours_no_temporal` | Ablation: every believed version (superseded too), with no dates anywhere |
| `ours_no_provenance` | Ablation: as `ours`, without the source quote and dialog id |

**Both LoCoMo speakers.** LoCoMo is a chat between two people, but the extractor (`extract.v1`) mines facts about
"the user". The harness keeps the prompt unchanged and builds two perspectives per sample: user A (as Stage 5
loads it) and a mirror user B with the same turns and the roles swapped. Each turn is mined exactly once, by the
person who said it, and each memory is shown as "about <name>". Both memory stores get the **same** extracted facts
(one shared extraction per message), so they differ only in how they reconcile and store them.

**Scoring** (`eval/metrics.js`, `eval/report.js`):
- LoCoMo-style token F1 per question category (multi-hop parts, open-domain before ";", adversarial = abstains).
  TODO: verify against the LoCoMo authors' evaluation code, which also stems words; ours does not.
- LLM judge (`prompts/judge.v1.md`, fixed rubric, never told which system answered).
- Evidence recall@k: the share of the question's evidence turns present in the context (for memories, through
  their source messages).
- Latency p50/p95 (retrieval + answer), tokens and cost per question, storage bytes per store.
- 95% bootstrap intervals (2,000 resamples, seeded): per system, and **paired** for `ours` minus each other system.
- Judge validation: `judge_validation.csv` holds 50 random answers without the system or the verdict, for you to
  label; `npm run eval:judge-agreement -- results/<run-id>` then gives agreement and Cohen's kappa.

**Pipeline check** (`npm run eval -- --questions 10` with `LLM_PROVIDER=mock`, commit `e1e896b`): ran end to end on
LoCoMo sample conv-26 (419 turns, 10 questions covering all five categories) for all six systems and wrote every
output file and chart. **Its numbers are not results**: the mock answers with the context item that shares the most
words with the question and judges by word overlap. They are deliberately not quoted here.

## 3. Cost projection for the paid run (a projection, not a measurement)

From `npm run eval:cost` (`results/stage6-cost-projection.txt`, commit `e1e896b`), with `claude-opus-5-5` for every
task at the prices in `services/llm/pricing.js`. Input tokens are estimated as characters / 4 of the exact prompts;
**assumed**: 0.5 facts per message reach reconcile, and 300 output tokens per call (thinking included).

| Scope | Projected cost |
|---|---|
| Pilot: 1 sample, 10 questions, 6 systems (extraction of the whole sample dominates) | 7.01 USD |
| Full LoCoMo: 10 samples, 1,986 questions, 6 systems + judge | 268.95 USD |

Prompt caching matters most for the full-context baseline: 23.50 USD with the conversation cached, 214.95 USD
without. The pilot measures the real facts per message and output tokens; re-run `npm run eval:cost` with them
(`-- --facts-per-message X --output-tokens Y`) before approving the full run.

## Limitations of the evaluation design (say these before anyone asks)

- **No real-model result yet.** Until the paid pilot runs, there is no evidence that ours is better or worse.
- **The extractor keeps durable facts, not events.** `extract.v1` deliberately skips one-off events, but many LoCoMo
  questions ask about events ("When did Caroline go to the support group?"). Expect the memory systems to lose to
  full context and RAG on those questions; that is a finding about the design, and it must be reported.
- **`ours` shows only current facts at the question date.** A question about an earlier state needs the superseded
  version, which `ours` hides unless the question gives a time. `ours_no_temporal` shows all versions, without dates.
- **Merged ranking across two people.** Each perspective is retrieved separately and the two lists are merged by
  score; the keyword part of the score is scaled per call, so the merge is close to, not exactly, one ranking.
- **Lexical embeddings.** The offline embedder matches words, not meaning (Stage 4). RAG and the memory systems would
  likely improve with a semantic embedder (Voyage, paid, not run).
- **The judge is an LLM.** Its agreement with a human must be checked on the 50-item sample before its numbers are
  trusted, and the same model family answers and judges (possible self-preference).
- **LongMemEval** (knowledge-update and temporal-reasoning questions, the most relevant to the bi-temporal model) is
  not run: Hugging Face is blocked in the cloud session.
- **LoCoMo excerpts.** The pipeline-check files contain 10 LoCoMo questions and answers. LoCoMo is CC BY-NC 4.0
  (Maharana et al., 2024, snap-research/locomo; see docs/DATASETS.md): non-commercial use with attribution.
