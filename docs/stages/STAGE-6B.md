# Stage 6b: Checkpoint and resume for the evaluation (viva notes)

Branch `claude/gifted-shannon-k7roei`, started from `main` with Stages 1-7 and 3b merged. It changes only `eval/`,
its tests and the docs. Prompts, models, scoring and the six systems are untouched, so nothing it adds changes what
the evaluation measures.

## 1. In one paragraph
The Stage 6 evaluation writes **nothing** to disk until every sample has finished. With the free local models the
full LoCoMo run was projected at about 90 hours (`results/stage6-pilot-ollama/timing.json`: judge 42%,
`full_context` 26%), so a closed laptop lid, a power cut, a Windows restart or a crash at hour 85 would have
thrown all of it away. Stage 6b adds a **checkpoint ledger**: every finished answer, store build and extraction is
appended as one line to `results/<run-id>/checkpoint.jsonl` the moment it exists (written and flushed to disk before
the next question starts). Running the **same command again** replays that file and continues: finished answers
are never asked again, a memory store that is still in MongoDB and was recorded as fully built is reused, and the
final files (`answers.csv`, summaries, charts, ...) come out the same as from an uninterrupted run. If the run
cannot be continued honestly (another model, prompt, `k`, seed, ...) it refuses instead of mixing two experiments.
It is a safety net: the plan is still to run continuously, and to use resume only when the laptop has to be moved
or switched off.

## 2. What changed
| File | Why |
|---|---|
| `eval/checkpoint.js` | New. The `Ledger`: append-only JSON-lines file (one `fsync`ed write per event), replay into memory, the run **fingerprint**, `discard` for redoing a group, a persistent extraction cache (`PersistentCache`), `Ledger.inspect()` for `--resume-check`. A damaged last line (a write cut off by a crash) is skipped |
| `eval/harness.js` | `evaluateSample()` takes `ledger` and `resetDb`. Systems are in four **groups** that share one build (`full_context`, `rag_messages`, the `bitemporal` store with `ours` / `ours_no_temporal` / `ours_no_provenance`, the `overwrite` store). Per group: skip it if complete, skip finished questions, reuse the MongoDB store if the ledger says it was built and the version count still matches, otherwise discard the half-done group and rebuild. `reattach()` finds the sample's users and messages again in MongoDB. Rows and builds are returned in the same order as before. Without a ledger the behaviour is exactly Stage 6 (the existing tests pass unchanged) |
| `eval/run.js` | Opens the ledger, computes the fingerprint, calls `evaluateSample` with `ledger` and `resetDb` (the disposable database is emptied only when a sample starts from nothing). New flags `--resume-check` (print what is done, run nothing) and `--restart` (keep the old checkpoint as `.jsonl.bak`, start again). `meta.txt` lists how many times the run was continued, with times and commits |
| `tests/eval-resume.test.js` | New, 17 tests: the ledger alone (durability, `undefined` to `null`, damaged line, fingerprint refusal, `--restart`, discard, cache), and with a real MongoDB and the mock model: stop the run at six different points (mid `full_context`, mid first memory system, mid second system of the same store, mid overwrite answers, after a build but before its marker, when the overwrite store starts) and check that the second start gives the same rows and builds as an uninterrupted run; the store is reused and not rebuilt; a wiped database makes a half-answered group redo itself from one new build; a finished run only reads the checkpoint |
| `README.md` | The "Evaluation" section: how to resume, `--resume-check`, `--restart`, and the per-sample loop |
| `docs/stages/STAGE-6.md`, `docs/stages/STAGE-6B.md` | This note, and a pointer from the Stage 6 note |

### What the ledger records (one JSON object per line)
| Line | Meaning |
|---|---|
| `run` | The first line: date, commit and the **fingerprint** (samples, questions per sample, `k`, seed, systems, provider, model names, Ollama context sizes, embedding model, prompt versions) |
| `resume` | The run was started again (time and commit; shown in `meta.txt`) |
| `row` | One finished (system, question): the whole `answers.csv` row with the judge verdict |
| `build` | A store build or size record (what `build.csv` shows) |
| `data`, `store_start`, `store_built` | Which users are in MongoDB, and whether the memory store there was fully built (and how many versions it has) |
| `discard` | Rows and builds of a group were thrown away to be redone |
| `cache`, `cache_reset` | Extracted facts, so the overwrite store gets the SAME facts as the bitemporal store even after a restart |
| `sample_done`, `complete` | Progress markers |

### What is lost when you stop
| You stop... | You lose, at most |
|---|---|
| while answering or judging | the one answer in progress (a few seconds; 42 s for a `full_context` answer on the 14B model) |
| while building the **bitemporal** store | that build (about 19 minutes per sample on the pilot's speed), and its extraction cache |
| while building the **overwrite** store | that build (about 9 minutes per sample); the extractions are kept |
| with MongoDB wiped or the eval database changed meanwhile | the store group that was half answered, which is redone from one new build |

## 3. Concepts
| Idea | Textbook name | One line |
|---|---|---|
| `checkpoint.jsonl` | **Write-ahead log / event log** | Each event is appended before the work moves on; the state is rebuilt by replaying the log |
| One `fsync`ed write per row | **Durability (the D in ACID)** | A line that was acknowledged survives a crash of the process; a half-written line is detected and skipped |
| Replaying the file | **Event sourcing / log replay** | The in-memory state is a pure function of the lines in the file |
| The fingerprint | **Run provenance / experiment identity** | Two runs are the same experiment only if models, prompts, `k`, seed and questions match; otherwise resuming is refused |
| Skipping finished rows | **Idempotent restart** | Running the same command twice gives the same final result as running it once |
| Store groups | **Consistent snapshot** | Every system of a group answers from one build; a half-answered group whose store is gone is redone as a whole |
| `discard` | **Compensating action** | Undoing earlier logged work by writing an event that cancels it, never by editing the log |
| Reusing the store in MongoDB | **Recovery by validation** | The ledger says what should be in the database; the code checks the counts before trusting it |
| `PersistentCache` | **Memoisation with persistence** | The extracted facts survive a restart, so both stores keep seeing the same extraction |
| `--restart` keeps a `.bak` | **Non-destructive operation** | Nothing in the results is deleted by a flag |

## 4. Examiner questions
1. **Why did the evaluation need a resume layer?**
   The full run on the local models was projected at about 90 hours, and the original harness wrote no results
   until every sample finished. One interruption (sleep, power cut, restart) would have lost everything. The
   layer makes an interruption cost at most one answer, or one store build.
2. **What exactly is saved, and when?**
   Every finished (system, question) row with its answer and judge verdict, every build record, the extraction
   results and a few markers, each as one line of `checkpoint.jsonl`, written and flushed to disk immediately.
3. **What happens if the computer dies in the middle of writing a line?**
   The last line is cut off. When the file is read, a line that is not valid JSON is skipped and counted
   (`--resume-check` shows it), and the next event is started on a fresh line. Only lines that were completely
   written were ever acknowledged, so nothing that counted is lost.
4. **How do you know a resumed run gives the same results as an uninterrupted one?**
   A test runs the evaluation with the mock model, stops it at six different points, resumes it, and compares
   every row (except timing columns) and every build record with an uninterrupted run. They are equal. With a
   real model the answers can differ slightly between runs, but an answer that is already recorded is never
   asked again.
5. **Why are the systems in groups, and why is a half-answered group sometimes redone?**
   `ours`, `ours_no_temporal` and `ours_no_provenance` must answer from the *same* bitemporal store, or their
   differences would partly be differences between two builds. If the store is still in MongoDB it is reused. If
   MongoDB lost it, the answers already given by that group belonged to a store that no longer exists, so the
   group is redone from one new build. `full_context` and `rag_messages` do not use a store, so their rows are kept.
6. **How does it know the store in MongoDB is the right one?**
   The ledger records when a store finished building and how many memory versions it had. On restart the code
   counts the versions in the database and checks that the sample's users, conversations and messages are all
   there. If anything differs, the store is not trusted and is rebuilt.
7. **Why does the overwrite store need a saved extraction cache?**
   Both stores must receive the same extracted facts (that is how Stage 6 keeps the comparison fair), and the
   overwrite store reuses the bitemporal store's extractions instead of calling the model again. That cache lived
   in memory, so a restart between the two builds would have lost it and re-extracted different facts. It is now
   in the ledger.
8. **Why does it refuse to resume sometimes?**
   Each ledger starts with a fingerprint of the experiment. If the model, prompt versions, `k`, seed, systems,
   questions, embedding model or context size differ, continuing would mix two experiments in one table, so it
   stops and names the fields that differ. `--restart` sets the old checkpoint aside as a `.bak` file.
9. **What did this change cost, and what did it not touch?**
   One file (`eval/checkpoint.js`), changes in `eval/harness.js` and `eval/run.js`, and tests. Prompts, models,
   scoring, the six systems and the database models are unchanged, and without a ledger `evaluateSample` behaves
   exactly as in Stage 6, which the older tests still check.
10. **Is the checkpoint an alternative to running continuously?**
    No. It is a safety net. Resuming still costs the unfinished answer or build, and `meta.txt` records every
    restart. The cleanest evidence is an uninterrupted run, and the results say whether the run was interrupted.

## 5. Weak points
- **A store build is not resumable in the middle.** A crash during the bitemporal build costs that build (about
  19 minutes per sample at the pilot's speed). Resuming per message would mean changing the extraction code, which
  Stage 6b deliberately did not touch. Say: "the maximum loss is bounded and small compared to the run."
- **A resumed run is not bit-for-bit identical with a real model.** The mock is deterministic, so the tests prove
  equality. A local model is not, and a group rebuilt after a wiped database gets a new store. Recorded rows are
  never changed, `meta.txt` lists each restart, and the result says it was resumed.
- **Settings outside the fingerprint are not checked.** The Ollama server's own settings (for example
  `OLLAMA_KV_CACHE_TYPE`, `OLLAMA_FLASH_ATTENTION`), the Ollama version and the GPU are not part of it. If they
  change between two starts, the rows before and after were produced under different conditions. Write the setting
  in the report, and do not change it in the middle of a run.
- **Durability stops at the operating system.** The ledger is `fsync`ed after each line, which protects against the
  process dying. It does not protect against a failing disk or a deleted folder, so `git push` after each sample
  (the loop in the README) is the real backup.
- **It trusts the file.** Someone who edits `checkpoint.jsonl` by hand can change the results. The file is plain
  text on purpose (to be inspectable), and the commit that holds it is the record.
- **One process at a time.** Two processes writing the same run-id would interleave lines and would also empty each
  other's database. The eval database is deliberately single-use (its name must contain `eval`).
- **Not tested against a real power cut.** The tests stop the run by an error before a write, and the manual check
  used `kill -9`. Both are process deaths, not a loss of power.

## 6. Demo on your laptop
Needs MongoDB as a replica set and the data from `npm run data:download`. The mock model is enough for the demo.

```powershell
git checkout main; git pull; npm install
npm test                                           # all pass, including tests/eval-resume.test.js

# 1. Start a small run and stop it halfway (press Ctrl+C after a few seconds)
$env:LLM_PROVIDER = 'mock'
npm run eval -- --questions 8 --systems full_context,rag_messages,ours,overwrite_memory --run-id demo-resume

# 2. See what is in the checkpoint, without running anything
npm run eval -- --questions 8 --systems full_context,rag_messages,ours,overwrite_memory --run-id demo-resume --resume-check
Get-Content results\demo-resume\checkpoint.jsonl -Tail 3     # the last events, one JSON object per line

# 3. Run the SAME command again: it continues, and finishes
npm run eval -- --questions 8 --systems full_context,rag_messages,ours,overwrite_memory --run-id demo-resume
Select-String -Path results\demo-resume\meta.txt -Pattern 'checkpoint'   # "started again after an interruption 1 time(s)"

# 4. Show the refusal: another setting is another experiment
npm run eval -- --questions 8 --k 5 --systems full_context,rag_messages,ours,overwrite_memory --run-id demo-resume
npm run eval -- --questions 8 --k 5 --systems full_context,rag_messages,ours,overwrite_memory --run-id demo-resume --restart   # keeps the old file as .bak
```

**The real run on Ollama (continuous, one folder per sample, safe to repeat after any stop):**

```powershell
$ids = (node -e "console.log(require('./data/locomo/locomo10.json').map(s=>s.sample_id).join(' '))") -split ' '
foreach ($id in $ids) {
  if (Test-Path "results\stage6-locomo-ollama-$id\meta.txt") { continue }    # this sample is finished
  npm run eval -- --provider ollama --embeddings ollama --samples $id --questions 0 --run-id "stage6-locomo-ollama-$id" *>> "results\logs\full-$id.log"
  git add results; git commit -m "Full LoCoMo run: sample $id finished"; git push origin HEAD
}
```
If it is stopped, run the same block again: finished samples are skipped, and the sample that was running continues
from its checkpoint. Check progress at any time with the same `npm run eval -- ... --run-id ... --resume-check`.
