# Stage 9: The final report and its evidence (viva notes)

Branch `claude/stage-9-paper`. No pull request has been opened. This stage holds the scripts and result files the
final report quotes, and the notes below. The report itself is a document (the "Database Project Report"), not a
file in the repository.

## 1. In one paragraph
The report has to show that the database design works and say honestly whether it helps answer questions. The
database half is measured: 18 representative queries and their plans, a sample of real API outputs including an
erasure demonstration, an index benchmark up to a million memories, and the test suite. The accuracy half comes from
two benchmarks run on local models. On LoCoMo (10 conversations, 1,986 questions) plain retrieval over messages was
more accurate than the bi-temporal design, which was close to overwrite-style memory. On a 48-question LongMemEval
pilot the same held, mostly on knowledge-update questions, and the stored memories showed why: the local extractor
recorded few changes of fact, so the versioned and overwrite stores were nearly identical. The result is negative, and the
report says so.

## 2. What changed
| File | Why |
|---|---|
| `scripts/report-queries.js`, `results/stage9-report-queries.txt`, `results/stage9-explain-seeded.txt` | The 18 queries (selection, joins, grouping, subqueries, set operations, `$graphLookup`, audit) and their `explain` plans on the seeded database |
| `scripts/report-api-samples.js`, `results/stage9-api-samples.txt` | Real API responses through supertest, including deleting a conversation and the erasure check. It changes the database; run `npm run seed` afterwards |
| `eval/pool.js`, `results/stage6-locomo-pooled*.{txt,csv}` | Pools the ten LoCoMo samples into one table with 95% bootstrap intervals, failed answers shown separately, paired comparisons per question type, and the answered retries replacing failed full-context answers (`--retry-dir`) |
| `results/stage6c-lme-pilot-pooled*.{txt,csv}` | The same pooling for the 48 LongMemEval questions (`--prefix stage6c-lme-pilot- --out-name ...`) |
| `eval/lme-diagnostics.js`, `results/stage6c-lme-pilot-diagnostics.txt` | Counts that explain the LongMemEval result: abstentions per system, identical answers, memory-store sizes |
| `package.json`, `README.md` | `report:queries`, `report:api`, `eval:pool`, `eval:lme-diagnostics` |

Merged in: the finished LoCoMo run (`claude/stage-6-ollama-run`), the LongMemEval harness and pilot (`stage-6c`) and the
full-context retry (`stage-6e`). See their own notes in `docs/stages/`.

## 3. Concepts
| Idea | Textbook name | One line |
|---|---|---|
| Bootstrap interval over questions | **Bootstrap confidence interval** | Resample the questions with replacement many times; the middle 95% of the means is the interval |
| Paired comparison of two systems | **Paired bootstrap** | Both systems are scored on the same questions, so question difficulty cancels out |
| Failed answers counted as wrong, and shown apart | **Intention-to-treat style reporting** | A system that fails often must not look better because its failures were dropped |
| Judge vs human labels | **Inter-rater agreement (Cohen's kappa)** | Agreement corrected for chance between the LLM judge and a person |
| Pilot with 48 questions | **Pilot study** | Shows whether an effect exists, not how large it is |
| Ablations (no temporal model, no provenance) | **Ablation study** | Remove one component and see what changes |
| Every number from a committed script | **Reproducibility** | Each result file records command, commit, date and dataset |

## 4. Examiner questions
1. **What is your main finding?** On both benchmarks plain retrieval over messages was more accurate than the bi-temporal design, and the design was close to overwrite-style memory. The database half (storage, queries, erasure) works as designed.
2. **Is that a failure?** It is a negative result for the accuracy hypothesis. The report states it and explains the likely cause on LongMemEval: about 240 user messages produced about 32 stored versions, only about 4 superseded.
3. **Why did plain retrieval win?** It keeps the raw messages, so it finds the evidence more often (evidence recall 0.83 against 0.41 on LongMemEval). The memory systems depend on an extractor that, on a local 14B model, stores only a small part of what was said, and they said "unavailable" more often (19 of 48 against 8 of 48).
4. **Does the provenance help?** On LoCoMo, yes: +0.045 token F1, higher in all ten conversations. On the 48-question pilot, no reliable difference.
5. **Does the temporal model help?** No measured accuracy benefit on either benchmark. The temporal model's value is in the database guarantees (as-of queries, audit), not in these accuracy numbers.
6. **Why is full context missing for most of LoCoMo?** Seven of the ten conversations need about 31,000 to 37,000 tokens, more than the model's native 32,768-token window. This is measured (`results/stage6e-locomo-fullcontext-token-fit.txt`). It is valid on three conversations, where it was not reliably different from the design.
7. **Can you trust the judge numbers?** Not yet fully. Agreement with human labels is reported separately; the token F1 numbers do not depend on the judge and point the same way.
8. **Why are the intervals wide for LongMemEval?** 48 questions, 24 per type. It is a pilot.
9. **What would you do next?** Extend the pilot, use an extraction model that records changes of fact more often, and run the full LongMemEval set.
10. **How do I know the numbers are real?** Every one comes from a committed script; each result file has the command, commit, date and dataset, and the raw per-question rows are in the run folders.

## 5. Weak points
- The result does not support the accuracy hypothesis. *Answer:* "Stated plainly in the abstract, results and conclusion; the contribution is the database design, its measured costs, and an honest evaluation."
- Local 14B models and a judge from another family; scores are not comparable with published numbers.
- The LongMemEval pilot has 48 questions and caps retrieved messages at 1,400 characters.
- Judge agreement with a human is measured on a small sample (50 LoCoMo, 48 LongMemEval answers labelled by the author).
- The 55 full-context calls that failed in the retry were not repaired; the likely cause (GPU memory) is inferred, not measured.

## 6. Demo on your laptop
```powershell
git checkout claude/stage-9-paper
npm install
npm test                                  # all pass (mock model only)
npm run seed
npm run report:queries                    # the 18 queries and plans -> results\stage9-report-queries.txt
npm run report:api                        # real API outputs and the erasure demo; then run: npm run seed
npm run eval:pool -- --retry-dir results/stage6e-locomo-retry-full_context
npm run eval:pool -- --prefix stage6c-lme-pilot- --out-name stage6c-lme-pilot-pooled --dataset-label "LongMemEval (benchmark), pilot, knowledge-update and temporal-reasoning"
npm run eval:lme-diagnostics
```
