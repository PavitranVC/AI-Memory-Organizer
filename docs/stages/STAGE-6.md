# Stage 6: Evaluation (viva notes)

Branch `claude/stage-6-evaluation`, stacked on Stage 4 (`claude/stage-4-hybrid-retrieval`). Built in the overnight
run: the harness is complete and checked on the **mock** model, the index benchmark **actually ran** at 10k, 100k
and 1M synthetic memories, and the paid LoCoMo evaluation waits for your approval (projected cost in
`results/stage6-cost-projection.txt`). The numbers, method and limitations are in `docs/RESULTS.md`.

## 1. In one paragraph
Stage 6 builds the machinery to test the project's claims instead of just asserting them. A database experiment
measures what the indexes of the `memories` collection buy and cost, from 10 thousand to 1 million rows, using
MongoDB's own `explain("executionStats")` and wall-clock time. An evaluation harness answers LoCoMo benchmark
questions with six systems that differ only in the context they give the same answer model: the whole
conversation, plain RAG over messages, an overwrite-style memory, our bi-temporal memory, and two ablations
(ours without the time fields, ours without provenance). Answers are scored with LoCoMo-style F1 and an LLM judge,
with bootstrap confidence intervals, and every run writes its command, commit, date and dataset next to its
results. This matters because the thesis ("versioned memory with provenance answers better than overwriting")
needs a fair, reproducible comparison, and the DBMS part of the course needs measured evidence about indexing.

## 2. What changed
- `eval/bench-indexes.js`: the index benchmark (10k / 100k / 1M synthetic memories, with and without indexes, explain + timing, index build and write cost). Now also records MongoDB's cache size.
- `eval/charts.js`: SVG charts drawn only from the CSVs in `results/`.
- `eval/meta.js`: git commit, machine, command line and CSV helpers shared by the scripts.
- `eval/stats.js`: percentiles, single and paired bootstrap confidence intervals.
- `eval/metrics.js`: token F1, LoCoMo-style scoring per question category, recall@k.
- `eval/systems.js`: the six systems and how each builds its context.
- `eval/harness.js`: runs every system on one LoCoMo sample (mirror user for the second speaker, two memory stores, answers, judge).
- `eval/report.js`: summary tables, the paired comparison with ours, the blind judge-validation sample.
- `eval/run.js`: the `npm run eval` command; refuses paid providers unless `--paid` is given.
- `eval/project-cost.js`: cost projection for the paid run (`npm run eval:cost`).
- `eval/judge-agreement.js`: agreement and Cohen's kappa between you and the judge.
- `prompts/eval-answer.v1.md`, `prompts/judge.v1.md`: the one answer prompt for all systems, and the judge rubric.
- `services/llm/index.js`: `callLlmDetailed` returns tokens and cost per call; a cache-break marker lets the full-context prefix be cached; new tasks `eval_answer` and `judge`.
- `services/llm/anthropicProvider.js`: sends the cached prefix as its own content block with `cache_control`.
- `services/llm/mockProvider.js`: deterministic stand-ins for the answer and judge tasks.
- `services/llm/schemas.js`, `services/llm/prompts.js`: the judge's JSON schema; the new prompt versions.
- `services/extractionService.js`: opt-in `versioning: 'overwrite'` (the baseline) and a shared extraction cache. The app never sets either.
- `services/retrieval/index.js`: opt-in `allVersions` for the no-temporal ablation. The app never sets it.
- `services/datasets/synthetic.js`: exports `ensureCategories` for the harness.
- `tests/eval.test.js`: 16 tests (metrics, statistics, summaries, prompt caching split, overwrite baseline, shared extraction, `allVersions`, the harness end to end on the mini LoCoMo fixture).
- `.github/workflows/ci.yml`: smoke runs of the index benchmark, the harness (mock) and the cost projection.
- `package.json`: `bench:indexes`, `eval`, `eval:cost`, `eval:judge-agreement`.
- `results/stage6-index-bench*`: the measured benchmark; `results/stage6-pipeline-check-mock-2026-10-12/`: the pipeline check (not a result); `results/stage6-cost-projection.*`: the projection; `results/logs/`: the run logs.
- `docs/RESULTS.md`, `README.md`, `.env.example` (`MONGO_URI_EVAL`).

## 3. Concepts
- **Secondary index (B-tree)**: a sorted copy of some fields with pointers to the documents; turns a scan into a seek.
- **Query plan / `explain("executionStats")`**: MongoDB's report of the chosen plan (IXSCAN, COLLSCAN, FETCH, SORT) and how many keys and documents it read.
- **Covered query**: the index alone answers it, so no document is read (`PROJECTION_COVERED`, 0 docs examined).
- **Selectivity**: the share of rows a condition matches; low-selectivity filters without an index force long scans.
- **Write amplification**: every insert also updates every index, so writes get slower as indexes are added.
- **Ablation study**: remove one component at a time to see what it contributes.
- **Baseline**: a simpler system to compare against (full context, RAG, overwrite memory).
- **Retrieval-Augmented Generation (RAG)**: give the model the top-k retrieved texts instead of everything.
- **Token F1 (SQuAD metric)**: overlap of words between answer and gold, harmonic mean of precision and recall.
- **LLM-as-a-judge**: a model grades answers against a rubric; must be validated against human labels.
- **Cohen's kappa**: agreement between two raters corrected for agreement by chance.
- **Recall@k**: share of the needed evidence that appears in the top-k context.
- **Bootstrap confidence interval (percentile method)**: resample questions with replacement many times; the middle 95% of the recomputed means is the interval.
- **Paired comparison**: both systems are resampled on the same questions, so question difficulty cancels out.
- **Prompt caching**: the provider stores a repeated prompt prefix; later calls pay about a tenth of the input price for it.
- **Bi-temporal model (valid time vs transaction time)**: when a fact was true vs when the database believed it (Stage 2).
- **Provenance / lineage**: each memory points to the messages it came from.

## 4. Examiner questions
1. **Why compare six systems instead of just reporting your accuracy?** A number alone means nothing. Baselines show whether the memory helps at all, and ablations show which part (time fields, provenance) helps.
2. **How do you make the comparison fair?** Same answer prompt, same model, same questions, same k. Both memory stores get the identical extracted facts from one shared extraction, so they differ only in how they store them.
3. **What does the index benchmark show?** At 1M memories the bi-temporal queries take about 1.4-1.7 s without indexes and about 2 ms with them; documents examined drop from about 558,000 to 22.
4. **Without indexes, why was the plan not always a COLLSCAN?** The queries sort by `_id`, so the planner walked the `_id` index backwards and filtered each document. It still read tens or hundreds of thousands of documents.
5. **What do indexes cost?** About 38-42% extra storage (177 MB of indexes for 460 MB of data at 1M) and 2-3.5 times slower bulk inserts; building them all took 25 s at 1M.
6. **Why bootstrap rather than a t-test?** Accuracy is 0/1 per question and not normally distributed; the bootstrap makes no distribution assumption and handles paired data directly.
7. **Why an LLM judge, and how do you trust it?** F1 punishes correct answers phrased differently. The judge is checked on 50 answers that I label without seeing the system or the verdict; I report agreement and Cohen's kappa.
8. **LoCoMo has two people talking. How do you extract facts from both?** The harness adds a mirror user with the roles swapped, so each person's turns are "user" messages exactly once; memories are labelled with the person.
9. **Why use synthetic data for the benchmark?** Only for performance, where the content does not matter but the size does. It is labelled synthetic and never used for accuracy.
10. **Where could your system lose?** On event questions: the extractor keeps durable facts, not one-off events, so full context and RAG may win there. The harness reports per question type so this is visible.

## 5. Weak points
- **No real-model results yet.** Say: "The harness is built and checked on a mock; the paid pilot is the next step, and its projected cost is computed from the real data."
- **Benchmark timings are one run on one machine.** Say: "The large effects (100x and more) are far beyond run-to-run noise; small differences are not claimed."
- **Mock numbers are meaningless.** They are labelled "pipeline check, not a result" in every file and not quoted.
- **LoCoMo-style F1 is our reimplementation** (no stemming). Marked TODO: verify against the authors' code; the judge is the main metric.
- **Lexical embeddings** make RAG and memory retrieval weaker than with a semantic model. Same embedder for all systems, so the comparison is still fair.
- **The judge and answer model are from the same family**: possible self-preference. The human validation sample is the check.
- **LongMemEval not run** (Hugging Face blocked), although its knowledge-update questions suit our design best.
- **No extraction precision/recall**: there is no human gold set yet (the annotation tool was skipped in Stage 5).

## 6. Demo on your laptop
Needs MongoDB as a replica set (see `STAGE-2.md`) and the LoCoMo file (`npm run data:download`). No API key needed.

```powershell
git checkout claude/stage-6-evaluation   # or main, once merged
npm install
npm test                                  # 267 tests, mock only
npm run data:download                     # if data\locomo\locomo10.json is missing

# 1. Index benchmark, quick version (about a minute); the full one is "npm run bench:indexes" (~6 min)
npm run bench:indexes -- --sizes 10000,100000 --repeats 10 --out results\demo-index-bench
Get-Content results\demo-index-bench.txt
Import-Csv results\demo-index-bench.csv | Where-Object memories -eq 100000 | Format-Table indexes, query, p50_ms, avg_docs_examined
start results\demo-index-bench-p50.svg

# 2. Evaluation harness on the mock (a pipeline check, NOT a result)
$env:LLM_PROVIDER = 'mock'; $env:EMBEDDING_PROVIDER = 'lexical'
npm run eval -- --questions 10 --run-id demo-check
Import-Csv results\demo-check\summary_by_system.csv | Format-Table system, n, score_f1_mean, judge_accuracy, recall_at_k_mean
Import-Csv results\demo-check\build.csv | Format-Table store, messages_mined, decisions, memory_versions, memory_bytes

# 3. Projected cost of the paid run
npm run eval:cost
```

To show that a paid run cannot start by accident: `$env:LLM_PROVIDER = 'anthropic'; npm run eval` stops with
"this run would call a paid API. Add --paid if you mean it." (set it back with `$env:LLM_PROVIDER = 'mock'`).
Delete the demo outputs afterwards (`Remove-Item -Recurse results\demo-*`) so they are not committed.
