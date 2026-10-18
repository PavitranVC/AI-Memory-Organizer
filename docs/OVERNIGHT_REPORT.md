# Overnight Report — 2026-10-18

Branch: `claude/stage-6-ollama-run`

## Next step: Full evaluation actively running in separate PowerShell window (started sample conv-26).

---

## A. Pre-flight checks — PASS

| Check | Result |
|---|---|
| git checkout main + pull | main up to date (2acf7f9) |
| node --version | v24.19.0 OK |
| npm install | OK |
| npm test (323 tests) | 323/323 PASS after 1 bug fix |
| ollama list | qwen2.5-coder:14b, deepseek-r1:14b, nomic-embed-text OK |
| ollama ps | No model loaded yet (loads on demand on GPU) |
| MongoDB replica set | rs.status().ok=1, set=rs0 OK |
| npm run migrate | 55 memories converted, indexes OK |
| npm run seed | 3 users, 60 embedded memories OK |
| npm start | Listens at http://localhost:5000 OK |
| .env LLM_PROVIDER | ollama OK |
| .env EMBEDDING_PROVIDER | ollama OK (was missing, added) |
| ANTHROPIC_API_KEY | unset OK |
| VOYAGE_API_KEY | unset OK |

Bug fixed: services/llm/prompts.js parsePrompt() now strips all \r (not just \r\n).
Full results: results/preflight-2026-10-18.txt

---

## B. Stage 3 live test — PASS

Command: npm run test:live (LLM_PROVIDER=ollama, EMBEDDING_PROVIDER=ollama)
Output: results/stage3-live-smoke-ollama-2026-10-18.json

10 calls in 38.0s, total cost $0.00
  extract   6 calls — input 9239 tokens, output 544 tokens
  reconcile 4 calls — input 2768 tokens, output 244 tokens
  memories: 6 versions stored (jobs done 6/6)

Extracted memories:
  1. Lives in Pune (superseded)
  2. Works as a data analyst at Infosys
  3. Moved to Mumbai in March 2025
  4. Starts a master's in Berlin next year
  5. Learning German
  6. Loves trekking on weekends

---

## C. Data and Pilot — PASS

### Data Download
- `npm run data:download`: LoCoMo dataset downloaded (2.8 MB, sha256 verified) to `data/locomo/locomo10.json`.

### Pilot Evaluation Run
- Run ID: `stage6-pilot-ollama` (1 sample `conv-26`, 419 messages, 10 questions)
- Models: Answer/Extract/Reconcile = `qwen2.5-coder:14b`, Judge = `deepseek-r1:14b`, Embeddings = `nomic-embed-text`
- Results directory: `results/stage6-pilot-ollama/`
- Output files: `LABEL.txt`, `meta.txt`, `config.json`, `raw.jsonl`, `answers.csv`, `summary_by_system.csv`, `summary_by_type.csv`, `bootstrap_vs_ours.csv`, `build.csv`, `timing.json`, `chart_f1.svg`, `chart_judge.svg`, `chart_recall.svg`.

### Gate Check (Counts-Only Verification) — PASS
| System | n | Mean Context Items | Rows with 0 Context | Rows with Error | Mean Recall@k |
|---|---|---|---|---|---|
| `full_context` | 10 | 419.00 | 0 | 1 | 1.000 |
| `rag_messages` | 10 | 10.00 | 0 | 0 | 0.650 |
| `ours` | 10 | 8.50 | 0 | 0 | 0.800 |
| `ours_no_temporal` | 10 | 8.50 | 0 | 0 | 0.800 |
| `ours_no_provenance` | 10 | 8.50 | 0 | 0 | 0.800 |
| `overwrite_memory` | 10 | 8.70 | 0 | 0 | 0.850 |

Store extraction counts (`build.csv`):
- `bitemporal` store: 419 messages mined, 0 failed, 419 extract calls, 248 reconcile calls, 167 memory versions (109 current) in 1142.6s (ADD=109, NOOP=86, SKIP=1, SUPERSEDE=7, UPDATE=51).
- `overwrite` store: 419 messages mined, 0 failed, 0 extract calls (cached), 248 reconcile calls, 100 memory versions (100 current) in 517.3s (ADD=100, NOOP=85, SKIP=1, SUPERSEDE=5, UPDATE=63).
Gate decision: **PASSED** (mean recall@k for ours = 0.800 > 0, 0 zero-context rows, 0 extraction failures).

### Pilot System Accuracy Summary
| System | n | F1 Mean (95% CI) | Judge Acc (95% CI) | Recall@k | Latency p50 (ms) |
|---|---|---|---|---|---|
| `full_context` | 10 | 0.2186 [0.0786, 0.3686] | 0.10 [0.00, 0.30] | 1.000 | 38,758 |
| `rag_messages` | 10 | 0.5522 [0.3744, 0.7522] | 0.80 [0.50, 1.00] | 0.650 | 7,441 |
| `overwrite_memory` | 10 | 0.4150 [0.2150, 0.6250] | 0.50 [0.20, 0.80] | 0.850 | 7,736 |
| `ours` | 10 | 0.4400 [0.2500, 0.6500] | 0.50 [0.20, 0.80] | 0.800 | 7,698 |
| `ours_no_temporal` | 10 | 0.4400 [0.2500, 0.6500] | 0.50 [0.20, 0.80] | 0.800 | 7,485 |
| `ours_no_provenance`| 10 | 0.3400 [0.1250, 0.5650] | 0.30 [0.00, 0.60] | 0.800 | 7,205 |

### Timing & Cost Projections
Measured from `results/stage6-pilot-ollama/timing.json`:
- Seconds per message: bitemporal = 2.727s, overwrite = 1.235s
- Seconds per answer: full_context = 42.324s, rag_messages = 8.336s, ours = 7.998s, ours_no_temporal = 8.448s, ours_no_provenance = 8.177s, overwrite_memory = 7.117s
- Seconds per judge: 11.609s
- Pilot measured time: 3180s (~53 min, 0.9h), $0.00
- Full LoCoMo projection: 325,283s (~90.4h), $0.00 (free local Ollama execution)

---

## D. Full run — Starting

---

## Needs you
(nothing blocked; gate check passed, proceeding with Step D)

