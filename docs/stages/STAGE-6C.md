# Stage 6c: Evaluating on LongMemEval (viva notes)

Branch `claude/stage-6c-longmemeval-eval`, started from the LoCoMo run branch (`claude/stage-6-ollama-run`) with the
Stage 5b loader merged in. No pull request has been opened. It does **not** change how LoCoMo is evaluated: the
LoCoMo path produces the same rows as before, and all earlier evaluation tests still pass.

This stage **prepares** the LongMemEval evaluation. No LongMemEval accuracy number exists yet; the run itself is a
separate step on the laptop.

## 1. In one paragraph
The LoCoMo results (Table 7.6 of the report) did not show that bi-temporal memory is more accurate, but LoCoMo has no
knowledge-update category, so it could not test the part of the hypothesis that matters most. LongMemEval has one
(78 knowledge-update and 133 temporal-reasoning questions in its 500). Stage 6c lets the Stage 6 harness run on
LongMemEval: each question is its own sample with its own chat history, scored by the same judge, with the same five
memory systems. It also adds a **preflight check** that finds, before any model is called, which samples cannot fit
the model's context window and projects how long a run will take. That check exists because the LoCoMo full-context
baseline failed on 1,546 of 1,986 questions (1,486 of them because the prompt was longer than the 32,768-token window), and nobody found out until the run was over.

## 2. What changed
| File | Why |
|---|---|
| `eval/harness.js` | `evaluateSample` now takes a `dataset` option. Sample preparation moved into `prepareLocomo` (unchanged behaviour: two perspectives, mirror user) and `prepareLongMemEval` (one perspective, the user; "now" is the benchmark's question date; evidence = turns marked `has_answer`). The reattach-after-interruption code handles any number of perspectives |
| `eval/metrics.js` | `longmemevalScore`: token F1, except an abstention question is right only if the answer says the information is unavailable. LoCoMo's per-category rules (multi-hop, open-domain, adversarial) do not apply to LongMemEval's categories |
| `eval/run.js` | `--dataset longmemeval` with `--file`, `--types`, `--per-type`, `--ids`. `full_context` is left out by default there (a history is about 150k estimated tokens). Warns when a requested system cannot fit. LoCoMo checkpoint fingerprints are unchanged, so an old LoCoMo checkpoint still continues |
| `eval/preflight.js` | `npm run eval:preflight`: per sample, estimated full-context tokens against the window, a projected duration from the LoCoMo pilot's measured per-item times, and the GPU share of the loaded model from Ollama's `/api/ps` |
| `tests/eval-longmemeval.test.js` | 6 tests on the hand-written LongMemEval-format fixture: scoring, one perspective, question date, evidence ids, preflight, end-to-end with the mock, abstention |
| `results/stage6c-lme-pilot-preflight.txt` | Output of the preflight for the planned pilot (24 questions), with command, commit and date |
| `README.md`, `docs/ROADMAP.md`, `package.json` | The command, the options and the stage row |

## 3. Concepts
| Idea | Textbook name | One line |
|---|---|---|
| One user per question | **Isolation of test cases** | Each question has its own history, so one question's memories can never help another |
| Question date as "now" | **Valid-time (as-of) query** | Memories are read as they stood on the day the question is asked |
| Gold answers kept in `evalitems` | **Train/test separation** | The system under test never sees the answer it is graded on |
| Judge verdict as the headline | **LLM-as-judge** | Free-form answers cannot be graded by string match; a model compares them with the gold answer |
| Abstention questions | **Negative / unanswerable test cases** | The right answer is "this was never said"; guessing is wrong |
| Preflight | **Fail-fast / pre-flight validation** | Impossible configurations are found before a multi-hour run, not after |
| Projection from pilot timings | **Capacity estimation** | A run's duration is estimated from measured per-item costs, and labelled as an estimate |
| Evidence recall@k | **Retrieval recall** | How many of the turns that hold the answer reached the model |

## 4. Examiner questions
1. **Why LongMemEval after LoCoMo?** LoCoMo has no knowledge-update category. LongMemEval does, and that is the claim
   the design makes: that versioned memory answers "what is true now" better than overwriting.
2. **Why is full_context missing?** A LongMemEval history is about 150k estimated tokens (3.3 characters per token,
   a safe over-estimate); even a model with a 128k window could not hold it. The preflight shows this per sample.
3. **Why not use a model with a bigger window?** All systems must use the same answer model, or a difference in
   accuracy could come from the model instead of the memory design.
4. **How is "now" chosen?** From the benchmark's `question_date`, so a knowledge-update question is answered from the
   facts valid on that day. In LoCoMo it was the day after the last session.
5. **Why one perspective, not two?** LongMemEval's two speakers are a user and an assistant. The extractor mines what the user says; mirroring would
   make the assistant's replies into "user" facts.
6. **What is the metric?** The judge verdict is the headline, as in the benchmark. Token F1 is a cheap second view.
   Abstention questions score 1 only if the answer says the information is unavailable.
7. **Is the judge reliable?** Not yet measured on LongMemEval. The judge prompt is the same one used for LoCoMo; its
   agreement with a human is checked on 50 labelled answers.
8. **Does the harness change affect the LoCoMo results?** No. The preparation code was moved, not changed, the LoCoMo fingerprints are unchanged, and the
   34 earlier evaluation tests pass unchanged.
9. **How long will it take?** The preflight projects about 17 minutes per question (24 questions: about 6.9 hours),
   from the LoCoMo pilot's per-item times. This is a projection and is **not** measured on LongMemEval.
10. **Why a pilot and not all 500 questions?** 500 questions at that rate is about 140 hours on this laptop, and the deadline is days away.

## 5. Weak points
- **The pilot is small** (24 questions, 12 per type), so intervals will be wide. *Answer:* "It is labelled a pilot; it
  tests whether the knowledge-update effect exists, not how large it is."
- **No full-context baseline.** *Answer:* "It cannot run on these histories with local models; the LoCoMo run showed the
  same limit, and the preflight now says so up front."
- **Assistant turns are not mined.** Questions whose evidence is in the assistant's replies (single-session-assistant)
  are hard for memory systems by construction; the pilot uses knowledge-update and temporal-reasoning only.
- **Judge prompt not tuned for LongMemEval.** The benchmark's own judge accepts some answers (for example off-by-one day counts) that ours may mark wrong.
  *Answer:* "The same judge is used for every system, so the comparison is fair, but absolute accuracy is not comparable
  with published numbers."
- **Projection, not measurement.** *Answer:* "Taken from the LoCoMo pilot's measured times, and labelled that way."

## 6. Demo on your laptop
Needs MongoDB (replica set), Ollama with `qwen2.5-coder:14b`, `deepseek-r1:14b` and `nomic-embed-text`, and the
LongMemEval file (`npm run data:download -- longmemeval`, 277 MB).

```powershell
git checkout claude/stage-6c-longmemeval-eval
npm install
npm test                                  # 362 tests pass (mock model only)

# 1. what would fit, and how long it would take (sends nothing to a model)
npm run eval:preflight -- --dataset longmemeval --types knowledge-update,temporal-reasoning --per-type 12

# 2. two questions with the mock model: checks the whole pipeline, takes seconds, NOT a result
npm run eval -- --dataset longmemeval --provider mock --embeddings lexical --types knowledge-update,temporal-reasoning --per-type 1 --run-id lme-mock-check

# 3. the pilot on the local models (resumable: run the same command again after an interruption)
npm run eval -- --dataset longmemeval --provider ollama --embeddings ollama --types knowledge-update,temporal-reasoning --per-type 12 --run-id stage6c-lme-pilot
npm run eval -- --dataset longmemeval --provider ollama --embeddings ollama --types knowledge-update,temporal-reasoning --per-type 12 --run-id stage6c-lme-pilot --resume-check
```
