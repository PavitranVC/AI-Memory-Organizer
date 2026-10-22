# Stage 6e: Repairing what can be repaired in the LoCoMo full-context baseline (viva notes)

Branch `claude/stage-6e-fullcontext-retry`, started from `claude/stage-6c-longmemeval-eval`. No pull request opened.
It changes no earlier result: the original run folders are never edited, and repaired answers are stored beside them.

## 1. In one paragraph
In the finished LoCoMo run the full-context baseline failed on 1,546 of 1,986 questions. This stage finds out why and
repairs only what is genuinely repairable. A committed script (`npm run eval:token-fit`) uses Ollama's own token counts
from the questions that did get answered to measure real characters per token (about 3.18, a little worse than the 3.3
the harness assumed) and shows that seven of the ten conversations really need 32,000 to 37,000 tokens, more than the
model's native 32,768-token window, so no retry can fix those 1,486 failures. The other 60 failures were timeouts in the
three conversations that do fit; `npm run eval:retry` asks exactly those again with a longer time limit.

## 2. What changed
| File | Why |
|---|---|
| `eval/token-fit.js`, `results/stage6e-locomo-fullcontext-token-fit.txt` | Measures, per conversation, whether the whole history fits the window, from committed answers and Ollama's real token counts |
| `eval/retry-failed.js` | Re-asks only the timed-out full-context answers (never the "does not fit" ones), one line per finished question so it can be stopped and restarted, writes to `results/stage6e-locomo-retry-full_context/`. Needs MongoDB only because each model call is logged |
| `eval/launch-retry.js`, `eval/retry-status.js` | `npm run eval:launch-retry` checks the conditions (same gate as the LongMemEval pilot), starts the retry in the background and returns; the retry writes `status.json` and commits and pushes its results every 10 answers and at the end; `npm run eval:retry-status` shows progress. A second launch is refused while one runs |
| `eval/harness.js` | Exports `answerAndScore` for the retry script; behaviour unchanged |
| `package.json` | `eval:retry`, `eval:token-fit` |

## 3. Concepts
| Idea | Textbook name | One line |
|---|---|---|
| Measuring the real tokenizer ratio | **Calibration** | An estimate is checked against measured values before it is trusted or blamed |
| Retrying only timeouts | **Idempotent retry of transient failures** | A transient failure may succeed later; a structural one cannot |
| Original rows kept, repairs stored beside them | **Append-only / audit trail** | Nothing already reported is rewritten |
| Journal line per finished question | **Write-ahead log / checkpointing** | A stopped run continues instead of starting over |

## 4. Examiner questions
1. **Why did full context fail?** For seven of ten conversations the whole history needs about 32,000 to 37,000 tokens, more than the 32,768-token window of the model, once room for the answer is kept.
2. **Was the estimate too strict?** No. Measured: 3.18 characters per token, against the 3.3 assumed, so the harness slightly under-counted tokens.
3. **Why not simply raise the window?** The model's native context is 32,768 tokens; beyond that quality is untested, and on a 12 GB GPU a larger window pushes part of the model onto the CPU.
4. **Why not use a model with a longer window for this baseline?** All systems must use the same answer model, or a difference could come from the model.
5. **What is repaired?** Only the 60 timeouts, all in the three conversations that fit.
6. **Are the original results changed?** No; repaired answers are stored separately and any table says which rows were used.
7. **Can the 1,486 be recovered?** Not with this model and window. Conversation conv-42 is close (about 30,800 tokens) and could be tried with a smaller answer reserve; the rest cannot.
8. **How should the full-context row be read?** As a baseline that is valid on three conversations only.

## 5. Weak points
- Full context stays unevaluated on seven of ten conversations. *Answer:* "It is a limit of the local model and the GPU, measured and documented, not hidden."
- The retry uses a longer timeout than the original, so retried answers had different conditions. *Answer:* "Recorded in `meta.txt`; they are reported as repaired rows."

## 6. Demo on your laptop
```powershell
git checkout claude/stage-6e-fullcontext-retry
npm install
npm run eval:token-fit                         # which conversations fit, and the measured ratio (changes no file)
npm run eval:launch-retry -- --provider ollama # checks, then runs the 60 timeouts in the background; about an hour
npm run eval:retry-status                      # progress; run the launch command again after an interruption
```
