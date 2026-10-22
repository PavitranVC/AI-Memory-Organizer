# Stage 5b: LongMemEval loader (viva notes)

Branch `claude/stage-5b-longmemeval`, started from `main`. No pull request has been opened. It touches nothing the
LoCoMo run branch (`claude/stage-6-ollama-run`) uses except one optional field on the `EvalItem` model.

This stage **loads** LongMemEval. It does **not** evaluate anything: there is no accuracy number for LongMemEval yet.

## 1. In one paragraph
Stage 6 compares memory systems on LoCoMo, but the thesis is about **knowledge updates and temporal questions**, and
LongMemEval is the benchmark built around exactly those (78 knowledge-update and 133 temporal-reasoning questions
among its 500). Stage 5b brings that benchmark into our database the same way Stage 5 did for LoCoMo: the file is
downloaded from Hugging Face (pinned to one commit and checked by its SHA-256), then loaded as benchmark users,
conversations and messages, while the gold answers go to the separate `evalitems` collection that the app never
reads. The one big difference from LoCoMo is that **every LongMemEval question has its own chat history**, so every
question becomes its own user. A pilot option loads only a small repeatable subset, because extracting memories
from all 247k messages with a local model would take too long.

## 2. What changed
| File | Why |
|---|---|
| `services/datasets/longmemeval.js` | The loader: date parsing, one user per question, sessions sorted by date, evidence turns kept as message ids, long turns cut and counted, one transaction per question, skip or reset, and `selectQuestions` for a seeded pilot subset |
| `scripts/datasets/load-longmemeval.js` | `npm run data:load:longmemeval` (`--types`, `--per-type`, `--seed`, `--ids`, `--reset`, `--file`). Refuses a file over 500 MB (the 2.7 GB "m" file does not fit in one JSON string) |
| `scripts/datasets/longmemeval-stats.js` | `npm run data:stats:longmemeval`: counts of the file (no database), written to `results/` |
| `scripts/datasets/download.js` | The LongMemEval entry was a guess that had never been fetched. It now points at the `longmemeval-cleaned` repository **pinned to a commit**, with the SHA-256 of both files; `longmemeval` is the 277 MB main file, `longmemeval-oracle` the 15 MB evidence-only file |
| `models/EvalItem.js` | Two optional fields: `questionDate` (the date a question is asked, needed to answer "as of" it) and `abstention`. LoCoMo items leave both unset |
| `tests/datasets-longmemeval.test.js`, `tests/fixtures/longmemeval-mini.js` | 16 tests. The fixture is **hand-written** in LongMemEval's format with the awkward cases of the real file, not LongMemEval data |
| `results/stage5b-longmemeval-stats-longmemeval_s_cleaned.json`, `results/stage5b-longmemeval-load.txt` | Output of the real runs on the 277 MB file, with command, commit, date and dataset |
| `docs/DATASETS.md`, `README.md`, `docs/ROADMAP.md`, `.claude/commands/viva.md`, `package.json` | The LongMemEval section replaces "not done"; two npm scripts; a roadmap row; `/viva 5b` |

## 3. Concepts
| Idea | Textbook name | One line |
|---|---|---|
| One user per question | **Isolation / partitioning by tenant** | Each question's memory is built only from its own history, so nothing leaks between questions |
| Sorting sessions by date before loading | **Chronological ordering for temporal data** | Memory is built oldest to newest; the file's own order is not time order for 211 of 500 questions |
| `has_answer` turns stored as message ids | **Provenance / ground truth for retrieval** | Lets Stage 6 measure whether retrieval found the right turns (recall@k) |
| Gold answers in `evalitems` | **Train/test separation (no label leakage)** | Same as Stage 5: the system under test never sees the answers |
| `questionDate` on the label | **Valid-time query point ("as of")** | A question is answered using only what was true at the date it is asked |
| One transaction per question | **Atomicity (ACID)** | A question is fully loaded or not at all |
| Skip if loaded, `--reset` to replace | **Idempotent load (ETL)** | Running the loader twice gives the same database as once |
| Pinned commit and SHA-256 | **Reproducibility / checksum** | The exact bytes the results were computed on can be checked later |
| `--per-type N --seed S` | **Stratified sampling with a seeded shuffle** | A pilot with every type represented that anyone can repeat exactly |
| Cut turns over 10,000 characters and count them | **Explicit loss accounting** | Nothing is dropped silently; the summary says how many were cut |

## 4. Examiner questions
1. **Why is LongMemEval needed when LoCoMo is already loaded?**
   The thesis is about knowledge-update and temporal questions. LongMemEval has 78 and 133 of them, labelled by type,
   and its histories are much longer. LoCoMo has temporal questions too, but only 321 and no knowledge-update type.
2. **Why one user per question?**
   Each question comes with its own history of about 48 sessions. Putting them all in one user would let the memory
   of one question answer another. The cost is storage: the same session can be stored many times.
3. **The file lists sessions out of date order. Why does that matter?**
   Bi-temporal memory reads a history from oldest to newest: a later fact supersedes an earlier one. If a newer
   session were read first, the old fact would wrongly supersede the new one. 211 of 500 questions have at least one
   session out of order, so the loader sorts by date.
4. **How do you avoid leaking the answers into the memory system?**
   Gold answers are only in `evalitems`, which no route or service of the app reads. The `has_answer` flag is not
   stored on messages; it only becomes the list of evidence ids in `evalitems`.
5. **What is an abstention question?**
   One with no answer in the history; the right behaviour is to say so. The benchmark marks them with an `_abs` id
   suffix (30 of 500). We store `abstention: true` and keep the benchmark's answer text. The suffix rule is our
   reading and is marked TODO: verify.
6. **Why did you use the "cleaned" version?**
   It is the version the Hugging Face repository now serves in place of the original, and its card says it removes
   noisy history sessions that interfere with correctness. Numbers are therefore comparable only with other runs on
   the cleaned data. We did not read the list of what was removed.
7. **Why not load the "m" file?**
   It is 2.7 GB, which does not fit in one JSON string in Node. Supporting it would need a streaming parser, and the
   thesis does not need it.
8. **What happens to turns longer than your message limit?**
   117 user turns (pasted documents or code, up to 76,560 characters) are cut to 10,000 characters and marked
   ` [truncated]`. The loader counts them in its summary. None of them is an evidence turn.
9. **How is the pilot chosen, and why does it matter?**
   `--types` and `--per-type N --seed S` pick N random questions per type with a seeded shuffle. The same seed gives
   the same questions, so a pilot is repeatable and covers every type chosen, instead of just the first questions in
   the file.
10. **Did you evaluate anything on LongMemEval?**
    No. This stage only loads the data and measures the load (500 questions, 246,738 messages in 43 s). The
    Stage 6 harness is written for LoCoMo and has to be adapted before it can answer LongMemEval questions.

## 5. Weak points
- **No accuracy result.** *Answer:* "This stage is the data pipeline. The evaluation on LongMemEval is the next step;
  I will not quote a number before it has run."
- **The harness does not read LongMemEval yet.** It expects LoCoMo's file, question categories and two-speaker
  setup. *Answer:* "The loader stores everything the harness needs, such as the question date, the evidence message
  ids and the type; adapting the harness is a separate, reviewed change."
- **Assistant questions.** 56 `single-session-assistant` questions ask what the *assistant* said, but the extractor
  only mines `user` messages. *Answer:* "Memory systems are expected to do badly there; I will report it rather than
  hide it."
- **Cut turns.** 117 long user turns lose their tails. *Answer:* "It is counted and none is evidence, but a cut could
  still matter for a question about that text."
- **Category numbers and the `_abs` rule are our reading**, not the authors', and the citation and the licence
  (MIT, from the dataset card) are not yet verified against the authors' repository.
- **The cleaned release is not the original benchmark.** *Answer:* "It is what the authors now publish in its place;
  I state which release I used."
- **Storage.** A 500-question load is about 286 MB of data, mostly repeated sessions.
- **Loaded users all share `SEED_PASSWORD`**: development only.
- **Next step:** after the LoCoMo run finishes, run a pilot (`--per-type 5` on knowledge-update and
  temporal-reasoning), read its time projection, then decide the scope. The harness needs a LongMemEval mode first.

## 6. Demo on your laptop
Needs MongoDB running as a replica set (see `STAGE-2.md`) and internet access to huggingface.co. **Do this only
after the LoCoMo run has finished**, and with a different `MONGO_URI` than the run's `aimemory_eval` database.

```powershell
git fetch origin
git checkout claude/stage-5b-longmemeval
npm install
npm test                                  # all pass (mock only, no key)
$env:MONGO_URI = 'mongodb://127.0.0.1:27017/aimemory_lme'
npm run data:download -- longmemeval      # 277 MB, "hash verified"
npm run data:stats:longmemeval            # counts of the file -> results\stage5b-longmemeval-stats-...json
npm run data:load:longmemeval -- --types knowledge-update,temporal-reasoning --per-type 3 --seed 1
npm run data:load:longmemeval -- --types knowledge-update,temporal-reasoning --per-type 3 --seed 1   # again: all "skipped"
```

Show the data in the MongoDB shell (gold answers are not reachable through the API):
```powershell
mongosh aimemory_lme --quiet --eval "db.evalitems.aggregate([{`$group:{_id:'`$questionType',n:{`$sum:1}}}])"
mongosh aimemory_lme --quiet --eval "db.evalitems.findOne({questionType:'knowledge-update'},{question:1,answer:1,questionDate:1,evidence:1})"
mongosh aimemory_lme --quiet --eval "db.conversations.find({},{title:1,'source.date':1}).sort({'source.date':1}).limit(3)"
```

Remove the pilot when you are done: `mongosh aimemory_lme --quiet --eval "db.dropDatabase()"`.
