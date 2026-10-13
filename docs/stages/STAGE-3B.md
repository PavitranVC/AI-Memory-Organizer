# Stage 3b: Local AI with Ollama + study commands (viva notes)

Pull request: "Stage 3b: Local AI with Ollama + study commands" into `main`, branch `claude/stage-3b-ollama`.
It starts from `main` with Stages 1-7 merged, and also brings in `docs/LOCAL_SETUP.md` and the Ollama version of
`docs/OVERNIGHT_PLAN.md` from `claude/laughing-lamport-d9jmok`, which had never reached `main`.

## 1. In one paragraph
Stages 3-6 built an AI memory whose only real model was Claude through a paid API, so every real run (the live
smoke test, the LoCoMo evaluation) needed an API key and money; the projected cost of the full evaluation was
about $269 (`results/stage6-cost-projection.txt`). Stage 3b adds **Ollama**, which runs open models on the
student's own GPU for free and offline. Two new providers plug into the interfaces that already existed, so no
other code had to change: an **LLM provider** (`LLM_PROVIDER=ollama`) that asks `qwen2.5-coder:14b` to extract,
reconcile and answer, and a **different** model, `deepseek-r1:14b`, to judge the evaluation; and an **embedding
provider** (`EMBEDDING_PROVIDER=ollama`, `nomic-embed-text`) that finally gives the project free *semantic*
search instead of the lexical baseline. Because a local model costs time instead of money, the evaluation now
also records **seconds per item** and projects the **run time** of the full benchmark from a pilot. Every call is
still logged in `llmcalls` (real token counts from Ollama, cost 0). The tests talk to a **fake Ollama server**, so CI
never needs Ollama. Part B adds two Claude Code study commands: `/viva <stage>` (an examiner quiz) and
`/sync-docs` (keeps these notes and the README honest).

## 2. What changed
| File | Why |
|---|---|
| `services/llm/ollamaProvider.js` | New. `POST /api/chat` with the task's JSON schema as `format`; picks `num_ctx` per call; strips `<think>...</think>`; one retry on timeout or invalid JSON; returns Ollama's token counts. Also `ollamaPost()` (shared HTTP + timeout) and `listOllamaModels()` (for `test:live`) |
| `services/llm/config.js` | `ollama` is a valid `LLM_PROVIDER`. With it: `OLLAMA_MODEL` (default `qwen2.5-coder:14b`) for extract/reconcile/answer/eval_answer and `JUDGE_MODEL` (default `deepseek-r1:14b`) for judge; `OLLAMA_URL`, `OLLAMA_NUM_CTX` (8192), `OLLAMA_NUM_CTX_LARGE` (32768), `OLLAMA_TIMEOUT_MS` (300000) |
| `services/llm/index.js` | Builds the Ollama provider; a local provider's calls cost $0; logs `attempts` |
| `models/LlmCall.js` | New field `attempts` (1, or 2 after Ollama's retry); comments list `ollama` as a provider |
| `services/embeddings/ollamaProvider.js` | New. `POST /api/embed` with `OLLAMA_EMBED_MODEL` (default `nomic-embed-text`); the vector size comes from the server and is part of the id (`ollama:nomic-embed-text:768`); nomic's `search_query:` / `search_document:` prefixes; batches of 64 |
| `services/embeddings/config.js`, `index.js` | `ollama` is a valid `EMBEDDING_PROVIDER`; `readyEmbedder()` makes sure the size is known before `.dims` or `.id` is read |
| `services/embeddings/backfill.js` | Calls `readyEmbedder()` first, so after a model or size change the id is the new one and every old vector is redone |
| `scripts/atlas-index.js` | Asks the embedder for its real size before writing `numDimensions` |
| `scripts/live-smoke.js` | `npm run test:live` with `LLM_PROVIDER=ollama`: skips cleanly if Ollama is not reachable, fails with the `ollama pull` command if a model is missing, writes `results/stage3-live-smoke-ollama-<date>.json` |
| `eval/run.js` | `--provider`, `--model`, `--judge-model`, `--embeddings`; Ollama needs no `--paid` (Anthropic and Voyage still do); model names, embedder id and Ollama version in `meta.txt`/`config.json`; writes `timing.json` |
| `eval/report.js` | `timing()`: measured seconds per mined message (per store), per answer (per system) and per judge call |
| `eval/project-cost.js` | `--provider ollama` makes every cost $0; `--pilot <run dir>` adds the TIME projection (`-time.csv`) from the pilot's `timing.json` |
| `tests/ollama.test.js` | New, 20 tests against a fake Ollama HTTP server (see section 3, "test double") |
| `.claude/commands/viva.md` | New. `/viva <stage>`: read-only quiz, 10 questions one at a time, 3 follow-ups, a re-read list |
| `.claude/commands/sync-docs.md` | New. `/sync-docs`: compares code and docs, fixes docs on `claude/docs-sync-<date>`, runs tests, opens a PR, never touches `main` |
| `.env.example`, `README.md` | Ollama variables, the provider table, the eval commands, the study commands, limitations. `JUDGE_MODEL` is now commented out in `.env.example`, because its default depends on the provider |
| `docs/LOCAL_SETUP.md` | (from the plan branch) laptop setup; now also `EMBEDDING_PROVIDER=ollama`, the study commands and speed tips for 12 GB of VRAM |
| `docs/OVERNIGHT_PLAN.md` | (from the plan branch) the Ollama plan; the morning prompt now runs only on Ollama with exact commands, and the quiz step uses `/viva` |
| `docs/stages/STAGE-3B.md` | These notes |

**Fixes after the first laptop run** (branch `claude/stage-3b-fixes`):

| File | Why |
|---|---|
| `.gitattributes` | New. `eol=lf`: on Windows with `core.autocrlf=true` the prompt files were checked out with CRLF and every LLM call failed with "missing front matter" |
| `services/llm/prompts.js` | `parsePrompt()` normalises CRLF to LF first, so a prompt and its `promptHash` are the same on every machine |
| `eval/harness.js`, `eval/report.js`, `eval/run.js` | A failed answer, judge or extraction call no longer ends the run: the row keeps an `error` and is scored as wrong; `errors` per system and `failed_messages` per store are reported |
| `services/llm/ollamaProvider.js` | 3.3 instead of 4 characters per token when choosing `num_ctx` (4 under-counted qwen2.5 tokens) |
| `tests/eval.test.js`, `tests/llm.test.js` | A run with failing calls; CRLF and LF prompts parse to the same text |

## 3. Concepts
| Idea | Textbook name | One line |
|---|---|---|
| The same interface, different implementations | **Strategy pattern / dependency inversion** | `callLlm()` talks to "a provider"; mock, Anthropic and Ollama are swapped by one variable |
| JSON schema sent as `format` | **Constrained (grammar-based) decoding** | The model can only produce tokens that keep the output valid against the schema |
| `num_ctx` | **Context window** | How many tokens (prompt plus answer) the model can see; Ollama cuts silently what does not fit |
| Bigger window, more memory | **KV cache** | The model stores keys and values for every token in the window, so 32k tokens need several GB of VRAM |
| 14B model on a 12 GB GPU | **Quantisation** | Ollama's default tags store weights in about 4 bits each, so a 14B model takes about 9 GB (TODO: verify the exact tag on the laptop with `ollama show`) |
| A different model judges | **LLM-as-a-judge, self-preference bias** | A model tends to rate its own outputs higher, so the judge should not be the answering model (Zheng et al. 2023; Panickssery et al. 2024; TODO: verify) |
| `<think>` blocks | **Reasoning model / chain of thought** | deepseek-r1 writes its reasoning before the answer; it is removed so only the JSON is parsed |
| Vectors from nomic-embed-text | **Dense (semantic) embeddings** | Texts with similar meaning get nearby vectors, unlike the lexical baseline that only matches words |
| `search_query:` vs `search_document:` | **Asymmetric retrieval** | The model was trained to embed questions and stored texts slightly differently |
| Size in the embedding id | **Schema evolution of derived data** | Vectors are derived data (like an index); a new model or size invalidates them all, and the backfill rebuilds them |
| One retry, then an error | **Bounded retry** | A second attempt fixes transient failures; more would hide a real problem and waste GPU time |
| The fake server in the tests | **Test double (fake)** | A tiny HTTP server that answers like Ollama, so tests are fast, deterministic and need no model |
| Seconds per item × items | **Linear extrapolation from a pilot** | Measure a small run, scale it up; only as good as the assumption that the full run behaves like the pilot |
| Data never leaves the laptop | **Data minimisation / local processing** | With local models no conversation is sent to a third party (relevant to DPDP and GDPR, see `docs/PRIVACY.md`) |

## 4. Examiner questions
1. **Why add a local model at all, when the Claude provider already works?**
   Cost and control. The full LoCoMo evaluation was projected at about $269 with Claude, which a student cannot
   pay for every rerun. Ollama is free, works offline, keeps the conversations on the laptop, and the results are
   reproducible by anyone with the same open model. The price is lower quality and more time per call.
2. **Why `qwen2.5-coder:14b` for the work?**
   It was already on the student's laptop, a 14B model fits a 12 GB GPU when quantised, it follows JSON formats
   well (the extractor and reconciler must return strict JSON) and it supports a 32k-token context, enough for a
   whole LoCoMo conversation in the full-context baseline.
3. **Why is the judge a different model (`deepseek-r1:14b`)?**
   LLM judges show self-preference: they rate text that looks like their own more favourably. If the same model
   answered and judged, all six systems would be graded by their own author. A reasoning model also checks the
   answer against the gold answer more carefully. The judge is still validated against human labels
   (`judge_validation.csv`, `npm run eval:judge-agreement`) before its numbers are trusted.
4. **How do you make sure the model returns valid JSON?**
   Three layers: the schema is sent as `format`, so Ollama constrains decoding to it; the provider removes any
   `<think>` block and code fences, then parses; and the existing validators in `services/llm/schemas.js` check
   ranges and enums again. If parsing fails, the call is retried once (at temperature 0.3, since temperature 0
   would repeat the same output), then it fails with `LlmError` and the job worker's own retries take over.
5. **What is `num_ctx` and why two sizes?**
   It is the context window in tokens, prompt plus answer. Ollama silently drops what does not fit, which would
   corrupt the full-context baseline. Each call gets 8192 when its estimated size fits, 32768 only when needed,
   and a prompt too long for both is refused instead of cut. Only two sizes, because Ollama reloads the model
   whenever `num_ctx` changes, and a bigger window costs GPU memory (the KV cache).
6. **How are tokens and cost logged for a free model?**
   The same `llmcalls` row as before: `inputTokens` = Ollama's `prompt_eval_count`, `outputTokens` = `eval_count`
   (summed over both attempts if it retried), `latencyMs`, `model`, `servedModel`, `attempts`, and `costUsd: 0`.
   `tokensEstimated` is false, because these are the model's own counts, unlike the mock's characters/4.
7. **The embedding size is not configured anywhere. How does the system know it?**
   The provider starts with a known guess (768 for nomic-embed-text), and every answer from `/api/embed` tells the
   real length. `ready()` asks once when the size is unknown. The size is part of `embeddingModel`
   (`ollama:nomic-embed-text:768`), so vectors of different sizes are never compared, and a change of size makes
   `npm run embed:backfill` re-embed every memory.
8. **How do you test code for a server that CI does not have?**
   `tests/ollama.test.js` starts a small HTTP server on a random port that answers like Ollama. It checks the
   request (model, schema as `format`, `num_ctx`, temperature), `<think>` stripping, the retry on invalid JSON and
   on a timeout, a missing model, a stopped server, the model per task, `llmcalls` rows, embeddings and a backfill
   after a size change. All tests still use the mock everywhere else (`tests/setupEnv.js`).
9. **Why does the evaluation now measure time, and how is the full run projected?**
   With a free model the limit is hours, not dollars. Each run writes `timing.json`: seconds per mined message for
   each memory store, per answer for each system, and per judge call. `npm run eval:cost -- --provider ollama
   --pilot results/<pilot>` multiplies them by the number of messages and questions in the full LoCoMo run.
10. **Does a weaker local model invalidate the thesis results?**
    No, but it changes what they mean. Every system gets the same answer model and the same judge, so the
    comparison between systems is fair; the absolute accuracy is lower than with a frontier model. The model names
    are recorded in every `results/` run, and the paper must say which models were used.

## 5. Weak points
- **Ollama could not run in the cloud session** (its model registry is blocked there), so CI tests the providers
  against a fake server only. The first real runs were on the laptop on 2026-10-13: the live smoke test passed and
  a 10-question pilot ran (outputs to be committed in `results/`). That run found three problems, see "Fixes after
  the first laptop run" below.
- **The judge is not a fully independent family.** `deepseek-r1:14b` is DeepSeek's R1 distilled into a
  Qwen2.5-14B base, and `qwen2.5-coder:14b` is also Qwen2.5. They are different fine-tunes, not different
  families. Answer: "it removes the exact self-grading, and the judge is checked against my own labels with
  Cohen's kappa; `JUDGE_MODEL` can be set to another family (for example a Llama or Gemma model) for a check".
- **Constrained output may suppress the reasoning.** With a JSON schema as `format`, a reasoning model may answer
  without thinking first. TODO: verify on the laptop how `deepseek-r1:14b` behaves with `format`.
- **14B models are weaker** than Claude at extraction and reconciliation (more missed facts, wrong SUPERSEDE vs
  UPDATE). The results describe these models, not the best the method can do.
- **The window size is an estimate** (3.3 characters per token plus a margin). The first estimate (4) was too low
  for qwen2.5's tokenizer on LoCoMo text, which could have let Ollama cut a prompt silently. With 3.3, the longest
  LoCoMo conversations no longer fit in 32768 tokens, so their full-context answers fail and are counted as errors
  (wrong). That is a real limit of a 32k-context model, not a bug; raising `OLLAMA_NUM_CTX_LARGE` beyond qwen2.5's
  native 32k context is possible but untested.
- **A failed call counts as a wrong answer.** If an answer or judge call fails after its retry, the row is kept
  with an `error` and scored F1 0 / judge 0, and `summary_by_system.csv` reports `errors` per system. Dropping those
  rows instead would flatter a system that fails often. A message whose extraction fails is skipped and counted
  in `build.csv` (`failed_messages`).
- **Time, not money.** The answer model and the judge do not fit in 12 GB together, so Ollama swaps them; the
  full-context answers may spill to the CPU. The time projection is a linear extrapolation from one pilot sample.
- **Ollama reuses its prompt cache**, so `prompt_eval_count` can be lower than the prompt length on repeated
  prefixes (TODO: verify). Token totals for Ollama are therefore "tokens processed", not "tokens sent".
- **"Cost 0" ignores electricity and hardware.** It means no per-token bill.
- **The vector cut-off for Ollama embeddings (0.5) is not calibrated** (`minVector`, marked TODO in the code).
- **The study commands are prompts, not programs.** `/viva` is told never to edit files and only gets read
  tools pre-approved; `/sync-docs` is told never to push to `main`, and `.claude/settings.json` also denies it.

## 6. Demo on your laptop
Needs MongoDB as a replica set (`STAGE-2.md`) and Ollama running with the three models (`docs/LOCAL_SETUP.md`).

```powershell
git checkout claude/stage-3b-ollama   # or main, once merged
npm install
npm test                               # 321 tests; mock only, Ollama not needed
ollama list                            # qwen2.5-coder:14b, deepseek-r1:14b, nomic-embed-text

# The live smoke test on the local models (free). Prints the extracted memories, tokens and time.
$env:LLM_PROVIDER = 'ollama'; $env:EMBEDDING_PROVIDER = 'ollama'
npm run test:live
ollama ps                              # which model is loaded, and GPU vs CPU

# Show that it skips cleanly when Ollama is not reachable
$env:OLLAMA_URL = 'http://localhost:9'; npm run test:live; Remove-Item Env:OLLAMA_URL

# What was logged: provider ollama, real tokens, cost 0
npm run llm:costs

# Semantic search: the seed embeds its memories with nomic-embed-text
npm run seed                           # prints "Embedding model: ollama:nomic-embed-text:768 (768 dimensions)"
npm run embed:backfill                 # embedded 0: every vector is already from this model and size

# Evaluation pilot (1 sample, 10 questions, all six systems), then the time projection
npm run data:download
npm run eval -- --provider ollama --embeddings ollama --questions 10 --run-id stage6-pilot-ollama
Get-Content results\stage6-pilot-ollama\timing.json
npm run eval:cost -- --provider ollama --pilot results/stage6-pilot-ollama --out results/stage6-projection-ollama
Get-Content results\stage6-projection-ollama.txt

# Study commands, inside Claude Code
#   /viva 3b      quiz on these notes
#   /sync-docs    check the docs against the code (opens a PR)
```
