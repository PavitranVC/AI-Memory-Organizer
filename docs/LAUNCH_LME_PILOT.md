# Launching the LongMemEval pilot (and checking on it later)

The pilot runs **one question at a time**. Each question has its own run folder and checkpoint, and is committed and
pushed as soon as it finishes, so a crash, a power cut or a closed terminal loses at most the question in progress.

## What is checked before anything starts (`eval/gate.js`)
Nothing starts unless all of these pass; the failed ones are printed with the reason.
| Check | Why |
|---|---|
| git branch is not `main`, tracked files are clean | Backups commit only `results/`, and never to `main` |
| LongMemEval file present | Nothing to run without it |
| Ollama reachable, the answer, judge and embedding models installed | A missing model would fail every call |
| Loaded model fully on the GPU | A model that spills onto the CPU is far slower and times out |
| **Worst-case answer prompt fits the small context window** | Ten retrieved messages of 10,000 characters would not. Each retrieved message is capped at 1,400 characters for every system, so no prompt can outgrow the 8,192-token window and the large window (the one that spilled last time) is never needed to answer |
| `full_context` left out | A LongMemEval history is about 150k estimated tokens; it cannot fit any local window |
| MongoDB reachable and a replica set | Transactions need one |
| No other batch with the same id is running | Two batches would share one database and corrupt each other |

The cap is recorded in each run's `meta.txt` and `config.json`, and a limitation of the study: if the answer sits
past character 1,400 of a long message, plain retrieval cannot show it to the model. The extractor still reads the
whole message.

## Start it (one command, then it goes quiet)
```powershell
npm run eval:launch -- --batch-id stage6c-lme-pilot --types knowledge-update,temporal-reasoning --per-type 12
```
It runs the checks, starts the batch as a hidden background process, confirms within 45 seconds that it is running
(pid printed), and exits. It does not wait for the run. Keep the laptop plugged in and awake; do not start another
job on the GPU.

## Check on it later
```powershell
npm run eval:status                       # state, questions done, current question, time left, last log lines, git state
git fetch; git log origin/claude/stage-6c-longmemeval-eval --oneline -5     # one commit per finished question
```
`results/stage6c-lme-pilot-status.json` is committed with every backup, so after a `git pull` you can read the progress
on any machine. Logs: `results/logs/stage6c-lme-pilot.log` (the batch) and `.console.log` (its console).

## If it stops
The same `npm run eval:launch ...` command again. Finished questions are skipped; the interrupted one continues from
its checkpoint. The batch halts by itself, without looping, after 3 questions in a row fail (state `halted`, with the
reason, e.g. Ollama is not running). Do not push other commits to the pilot's branch while it runs: its pushes would
be rejected until you `git pull`.

## Prompt for Antigravity (starts the run, then stops)
Replace `<REPO_DIR>` with the folder of the separate clone. Paste everything in the block.

```text
You are starting a long-running evaluation on this Windows laptop. Your job is ONLY to check conditions and
start it, then stop. Do NOT keep the session open, do NOT poll, sleep, tail logs or wait for the run to
progress. Do NOT edit, create or delete any source file, and do NOT commit or push anything yourself.
Use PowerShell. If any step fails, stop at once and tell me which step failed and the exact error text.

1. cd <REPO_DIR>
2. git fetch origin
   git checkout claude/stage-6c-longmemeval-eval
   git pull --ff-only origin claude/stage-6c-longmemeval-eval
   git status --short --untracked-files=no     (must print nothing; if it prints anything, stop)
3. npm install
4. ollama list    (must show qwen2.5-coder:14b, deepseek-r1:14b and nomic-embed-text; if one is missing, stop. Do not pull models.)
5. mongosh --quiet --eval "rs.status().ok"    (must print 1; if MongoDB is not running or not a replica set, stop.)
6. If the file data\longmemeval\longmemeval_s_cleaned.json does not exist, run: npm run data:download -- longmemeval
7. nvidia-smi    (just show the output in your report; if another process is using the GPU heavily, stop and tell me.)
8. $env:MONGO_URI_EVAL = "mongodb://127.0.0.1:27017/aimemory_eval"   (use the replica-set URI from .env if it differs)
9. npm test    (all tests must pass; if any fail, stop.)
10. npm run eval:launch -- --batch-id stage6c-lme-pilot --types knowledge-update,temporal-reasoning --per-type 12
    This checks every condition itself. It must print "LAUNCHED: batch stage6c-lme-pilot is running in the
    background (pid ...)". If it prints "Not launched", stop and give me the lines marked [FAIL].
11. Run once: npm run eval:status    and include its output in your report.
12. Finish with a short report: the pid, the number of questions, and these two commands for me to use later:
      npm run eval:status
      git fetch; git log origin/claude/stage-6c-longmemeval-eval --oneline -5
    Then END THE SESSION. Do not wait for the evaluation.
```
