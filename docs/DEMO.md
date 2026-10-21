# Viva demo guide (Windows, PowerShell)

One file to follow live in a ~10 minute viva. Everything is typed in **PowerShell**, from the project folder
(`cd C:\Education\VIT\Projects\AI-Memory-Organizer`). Each stage's own demo is in `docs/stages/STAGE-N.md`
(section 6); this guide is the short path through all of them.

What you will show, in order: **extraction** (a chat message becomes memories), **SUPERSEDE** (a changed fact closes
the old version, "as-of" still returns it), **`/api/ask`** (answers with citations), **privacy** (consent, erasure
by lineage, export) and **where the evaluation numbers live**.

The commands were run for real against a fresh `npm run seed` database with the mock LLM (the answers shown below
are what the mock prints). With `LLM_PROVIDER=ollama` the wording of memories and answers differs and each step takes
seconds longer; the steps and fields are the same.

## 0. Before the viva (do this 15 minutes earlier)

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | MongoDB is a replica set | `mongosh --quiet --eval "rs.status().ok"` | `1` |
| 2 | `.env` exists | `Test-Path .env` (if `False`: `Copy-Item .env.example .env`) | `True` |
| 3 | Tests pass | `npm test 2>&1 \| Select-Object -Last 8` | `Tests: ... passed`, none failed |
| 4 | Fresh demo data | `npm run seed` | prints the three users and "password for every seeded user" |

`npm test` uses its own database `aimemory_test` and only the mocks, so it never touches the demo data.
`npm run seed` resets users, conversations, memories, audit log and jobs, so run it again any time the demo got messy.

`.env` values that matter (all documented in `.env.example`):

| Variable | Demo value | Meaning |
|---|---|---|
| `MONGO_URI` | `mongodb://127.0.0.1:27017/aimemory` | the demo database (any name works, the seed fills it) |
| `PORT` | `5000` | the API port; every command below assumes it |
| `LLM_PROVIDER` | `mock` (safe) or `ollama` | who extracts and answers. `mock` is deterministic and instant |
| `EMBEDDING_PROVIDER` | `lexical` (default) or `ollama` | `lexical` is an offline keyword-hash baseline; `ollama` is a real semantic model |
| `WORKER_IN_PROCESS` | `true` for the demo | runs the extraction worker inside `npm start`. If `false`, you must run `npm run worker` in a second window or no memories appear |
| `SEED_PASSWORD` | `DevPassword123` (default) | password of every seeded user |

> **If the long evaluation is still running** (`ollama ps` shows a model loaded, `nvidia-smi` shows GPU use), the demo
> **shares the GPU** with it: a live Ollama demo will be slow, and it can slow the evaluation down. Use the mock for the
> live demo (`$env:LLM_PROVIDER = 'mock'` in the window that runs `npm start`; a variable set in the shell wins over
> `.env`) or a smaller model, and **say so to the examiner**: "the live demo uses the deterministic mock model so that
> it does not disturb the evaluation that is running on the GPU; the real-model results are in `results/`."
> Also change `PORT` or `MONGO_URI` if the evaluation uses the same ones (the evaluation uses its own database
> `MONGO_URI_EVAL`, which `npm run eval` drops; never point the demo at it).

## 1. Start the API and log in

**Window 1** (leave it open):
```powershell
$env:LLM_PROVIDER = 'mock'          # or 'ollama' if the GPU is free
$env:EMBEDDING_PROVIDER = 'lexical' # or 'ollama' (then run: npm run embed:backfill, once)
$env:WORKER_IN_PROCESS = 'true'     # API + extraction worker in one window
npm start
```
Expected: `MongoDB connected`, `Extraction worker running in-process (LLM provider: mock)`,
`Server running at http://localhost:5000`.

**Window 2** (all the rest). Log in as the seeded user Priya and keep the token in `$h`:
```powershell
$b = 'http://localhost:5000'
$login = Invoke-RestMethod -Method Post "$b/api/auth/login" -ContentType 'application/json' -Body '{"email":"priya.nair@example.com","password":"DevPassword123"}'
$h = @{ Authorization = "Bearer $($login.token)" }
```
Seeded users (`seed.js`): `aarav.mehta@example.com` (admin), `priya.nair@example.com`, `daniel.fernandes@example.com`;
password `DevPassword123` unless you changed `SEED_PASSWORD`. Priya has a home-city history (Kochi, then Bengaluru
from 1 Aug 2024). The token lasts `JWT_EXPIRES_IN` (7 days), so it will not expire during the viva.

## 2. A message becomes memories (extraction)

```powershell
$c = Invoke-RestMethod -Method Post "$b/api/conversations" -Headers $h -ContentType 'application/json' -Body '{"title":"Viva demo"}'
$say = { param($t) Invoke-RestMethod -Method Post "$b/api/conversations/$($c._id)/messages" -Headers $h -ContentType 'application/json' -Body (@{ role = 'user'; content = $t } | ConvertTo-Json) }

$m1 = & $say 'I live in Pune since 2020'
$m1 | Select-Object _id, role, extractionJobId        # returns at once; extraction runs in the background
```
Wait for the job (usually 1 to 3 seconds with the mock, longer with Ollama), then look at what it created (the first decision is `ADD`, "No existing memory states this fact"):
```powershell
function Wait-Job2($id) { do { Start-Sleep 1; $j = Invoke-RestMethod "$b/api/jobs/$id" -Headers $h } while ($j.status -in 'pending', 'running'); $j }
(Wait-Job2 $m1.extractionJobId).status                # done
(Invoke-RestMethod "$b/api/jobs?limit=1" -Headers $h).jobs[0].result.decisions | Format-Table action, topic, reason
(Invoke-RestMethod "$b/api/memories?limit=50" -Headers $h).memories | Where-Object content -like '*Pune*' | Format-Table content, validFrom, validTo, sensitivity
```
Show: the chat call did **not** wait for the LLM (it returned `extractionJobId`); the worker made a **decision**
(`ADD`, `SUPERSEDE`, `NOOP`, `ASK` ...) per extracted fact; the new memory has `validFrom` 2020-01-01 (the date in the
sentence, not today).

## 3. Change a fact: SUPERSEDE and "as-of"

```powershell
$m2 = & $say 'Big news: I moved to Mumbai in March 2025'
$null = Wait-Job2 $m2.extractionJobId
(Invoke-RestMethod "$b/api/jobs?limit=1" -Headers $h).jobs[0].result.decisions | Format-Table action, topic, reason   # SUPERSEDE
$cur = (Invoke-RestMethod "$b/api/memories?limit=50" -Headers $h).memories | Where-Object content -like '*Mumbai*'
(Invoke-RestMethod "$b/api/memories/$($cur._id)/history" -Headers $h).versions | Format-Table content, validFrom, validTo, supersededBy, isCurrent
```
Expected: two versions. "Lives in Pune": `validTo` 2025-03-01, `supersededBy` = the id of the Mumbai version,
`isCurrent` False. "Lives in Mumbai": `validFrom` 2025-03-01, `validTo` empty, `isCurrent` True. **Nothing was
deleted or overwritten**: the old belief is closed, not erased (that is what makes it bi-temporal).

The as-of query, today and in January 2024:
```powershell
(Invoke-RestMethod "$b/api/memories?category=Personal&limit=50" -Headers $h).memories.content
(Invoke-RestMethod "$b/api/memories?category=Personal&asOf=2024-01-01&limit=50" -Headers $h).memories.content
```
Today shows `Lives in Mumbai`; `asOf=2024-01-01` shows `Lives in Pune` (the old belief). The same exists for Priya's
seeded Kochi/Bengaluru history: `?asOf=2023-06-01` returns Kochi.

## 4. Ask a question, with citations

```powershell
$now = Invoke-RestMethod -Method Post "$b/api/ask" -Headers $h -ContentType 'application/json' -Body '{"question":"Where do I live?"}'
$now.answer; $now.citations | Format-Table label, content, validFrom, validTo
$then = Invoke-RestMethod -Method Post "$b/api/ask" -Headers $h -ContentType 'application/json' -Body '{"question":"Where do I live?","asOf":"2024-01-01"}'
$then.answer; $then.citations | Format-Table label, content, validFrom, validTo
$now | Select-Object insufficient, llmCalled, embeddingModel
$now.memories | Select-Object -First 3 | ForEach-Object { "{0:N3}  {1}" -f $_.score, $_.content }   # hybrid score of each retrieved memory
$now.memories[0].components | Format-List                                       # text, vector, recency, importance
```
With the mock the answer is `From your memories: Lives in Mumbai.` and the citation `m1` points to the Mumbai memory
(`validTo` empty); with `asOf` 2024-01-01 it answers Pune and cites the closed Pune version. The answer text comes
from the LLM, but **which memories it may use** is chosen by retrieval (keyword + vector + recency + importance,
always for this user only), and `citedMemoryIds` are checked against that list. If nothing relevant is found,
`insufficient` is true and `llmCalled` is false (no model call, no invented answer).

## 5. Privacy: consent, erasure, export

**Consent.** A category set to `ask` stores nothing until the user accepts:
```powershell
Invoke-RestMethod -Method Put "$b/api/me/consent/Hobbies" -Headers $h -ContentType 'application/json' -Body '{"mode":"ask"}'
$m3 = & $say 'I love trekking'
$null = Wait-Job2 $m3.extractionJobId
(Invoke-RestMethod "$b/api/me/suggestions" -Headers $h).suggestions | Format-Table content, confidence      # waits here
(Invoke-RestMethod "$b/api/memories?category=Hobbies&limit=50" -Headers $h).memories | Where-Object content -like '*trek*'   # prints nothing
```
Modes are `store`, `ask`, `never`. (`POST /api/me/suggestions/<id>/accept` stores a suggestion;
`DELETE /api/me/suggestions/<id>` rejects it.)

**Lineage-based erasure of a whole conversation.** Make a conversation with a sensitive fact, then delete it:
```powershell
$c2 = Invoke-RestMethod -Method Post "$b/api/conversations" -Headers $h -ContentType 'application/json' -Body '{"title":"Erase me"}'
$m4 = Invoke-RestMethod -Method Post "$b/api/conversations/$($c2._id)/messages" -Headers $h -ContentType 'application/json' -Body '{"role":"user","content":"I am allergic to shellfish"}'
$null = Wait-Job2 $m4.extractionJobId
(Invoke-RestMethod "$b/api/memories?category=Health&limit=50" -Headers $h).memories | Where-Object content -like '*shellfish*' | Format-Table content, sensitivity   # present, sensitivity special

(Invoke-RestMethod -Method Delete "$b/api/conversations/$($c2._id)" -Headers $h).erasure     # erasedVersions 1, deletedJobs 1 ...
(Invoke-RestMethod "$b/api/memories?category=Health&limit=50" -Headers $h).memories | Where-Object content -like '*shellfish*'   # now nothing
npm run erasure:verify -- --user $($login.user._id) --text shellfish    # OK: nothing derived from erased data remains.
(Invoke-RestMethod "$b/api/audit?limit=3" -Headers $h).entries | Format-Table action, at, tombstonedAt, reason
```
The memory was found through its **lineage** (`sourceMessageIds`), not by searching text: every memory remembers which
messages it came from, so deleting the source erases the derived memories, their jobs and their suggestions. The
audit log keeps a **tombstone** (the record that something was created and later erased, without the content).
Deleting a single message works the same way: `DELETE /api/conversations/<id>/messages/<messageId>`. Use a separate
message for each fact you want to erase: a memory that also came from a message you keep is not erased, only
unlinked.

**Export** (everything stored about Priya, as one JSON file):
```powershell
Invoke-WebRequest "$b/api/me/export" -Headers $h -OutFile priya-export.json
(Get-Content priya-export.json -Raw | ConvertFrom-Json).counts
Remove-Item priya-export.json       # it is personal data, even if it is sample data
```
Optional: `npm run retention -- --days 365 --dry-run` (only counts what would expire; nothing is deleted).

## 6. Evaluation: where the numbers are

**Rule: read every number from a committed file in `results/`; never quote one from memory.** Each result folder has
`LABEL.txt` / `meta.txt` with the command, git commit, date and dataset.

| What | Script | Output |
|---|---|---|
| Index benchmark (synthetic data, performance only) | `npm run bench:indexes` | `results/stage6-index-bench.csv`, `.txt`, `*-p50.svg` |
| Retrieval latency | `npm run bench:retrieval` | `results/stage4-retrieval-latency.csv`, `.txt` |
| LoCoMo QA evaluation, 6 systems | `npm run eval` (`eval/run.js`) | `results/<run-id>/` (`summary_by_system.csv`, `summary_by_type.csv`, `chart_*.svg`, `meta.txt`, `raw.jsonl`) |
| Charts | `node eval/charts.js eval results\<run-id>` or `node eval/charts.js index results\stage6-index-bench` | `.svg`, drawn only from the CSV files |
| Cost projection | `npm run eval:cost` | `results/stage6-cost-projection.*` |

Show on the laptop (nothing is recomputed, you only open committed files):
```powershell
Get-Content results\stage6-index-bench.txt | Select-Object -First 30
Import-Csv results\stage6-index-bench.csv | Select-Object -First 5 | Format-Table
Start-Process results\stage6-index-bench-p50.svg    # opens the chart in the browser
Get-Content results\stage6-pipeline-check-mock-2026-10-12\LABEL.txt     # a pipeline check on the mock model, NOT a result
```
The full LoCoMo run is the long Ollama evaluation. After it is merged to `main`, open `results\<run-id>\`
(`meta.txt` for the command/commit/date/dataset, `summary_by_system.csv` for the table, `chart_f1.svg`) and read the
numbers from there, including those that do not favour the thesis. Until it is merged, say: "the full run is still
executing; the committed results are the index benchmark and the retrieval latency, and the mock pipeline check
only proves that the harness works." Synthetic data is used for performance only and is never reported as real;
LoCoMo is a benchmark, not real user data. More detail: `docs/RESULTS.md`.

## 7. If something goes wrong

| Symptom | Cause | Fix (live) |
|---|---|---|
| `npm start` or `npm test` fails: "replica set" / "not primary" | MongoDB service is not a replica set, or is stopped | `Get-Service MongoDB`, `Start-Service MongoDB` (Admin PowerShell), then `mongosh --quiet --eval "rs.status().ok"`. Set-up steps: `docs/stages/STAGE-2.md` |
| `ECONNREFUSED 127.0.0.1:27017` | Mongo not running | same as above; Docker alternative: `docker run -d --name mongo -p 27017:27017 mongo:7 --replSet rs0` then `docker exec mongo mongosh --quiet --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]})"` |
| `EADDRINUSE` / port 5000 busy | an old server (or another app) uses 5000 | `netstat -ano \| findstr :5000`, then `Stop-Process -Id <PID>`; or `$env:PORT = '5001'` before `npm start` and `$b = 'http://localhost:5001'` |
| `401` / "Invalid token" | token missing, expired, or the server was restarted with a different `JWT_SECRET` | run the three login lines of section 1 again |
| Login says invalid credentials | database was not seeded, or `SEED_PASSWORD` changed | `npm run seed`, use `DevPassword123` or your `SEED_PASSWORD` |
| Message returns but no memory appears; `/api/jobs` stays `pending` | no worker running (`WORKER_IN_PROCESS=false`) | restart with `$env:WORKER_IN_PROCESS = 'true'; npm start`, or run `npm run worker` in a third window |
| Job `failed` or very slow, Ollama in use | Ollama is stopped, the model is not loaded, or the GPU is busy with the evaluation | `ollama ps`, `ollama list`; switch to the mock: `$env:LLM_PROVIDER = 'mock'` and restart `npm start` |
| `/api/ask` says `insufficient` for something that is stored | the lexical embedder is a keyword baseline | rephrase using the words of the memory; with `EMBEDDING_PROVIDER=ollama` run `npm run embed:backfill` once |
| `Invoke-RestMethod` shows only part of an object | PowerShell truncates nested output | pipe to `Format-Table` or `ConvertTo-Json -Depth 6` |
| Demo data is messy | earlier practice runs | `npm run seed` (resets the demo database), log in again |
| Everything fails | | show the code and `docs/stages/STAGE-N.md`, then the committed files in `results\`; the tests (`npm test`) need only MongoDB |

## 8. Two-minute talking script

> "This is an AI memory layer. A user chats; the system extracts **facts** and stores them as **memories** in MongoDB,
> and later answers questions from them with citations.
>
> *(Section 2)* When I send a message the API returns immediately and a **job** is queued. A worker asks the LLM to
> extract facts and then **reconciles** each one against what is already stored: create it, ignore it, or supersede
> an older fact. Every decision is written to an audit log.
>
> *(Section 3)* When I said I moved to Mumbai, the Pune memory was not overwritten. It was **closed** with a `validTo`
> and linked to the new version with `supersededBy`. So the database is **bi-temporal**: it knows when a fact was true
> in the world and when we recorded it. That is why 'where did I live in January 2024?' still returns Pune.
>
> *(Section 4)* Answers go through **hybrid retrieval**: keyword search, vector similarity, recency and importance,
> always filtered to the logged-in user. The model only sees those memories, and every answer lists the memories it
> used, so the answer can be checked. If nothing relevant exists, the system says so and does not call the model.
>
> *(Section 5)* Privacy is built in. Per category the user chooses store, ask or never. Every memory records the
> messages it came from, so deleting a conversation erases everything derived from it, and the check command
> proves nothing is left. The audit log keeps a content-free tombstone. The user can export all their data.
>
> *(Section 6)* Numbers are only taken from the scripts' result files in `results/`, each with the command, commit,
> date and dataset. Synthetic data is used only for performance tests; the mock-model check is labelled as not a
> result. The live demo used [the mock / Ollama model] [because the evaluation is using the GPU].
>
> The honest limits: the lexical embedder is a keyword baseline, the extractor's quality depends on the model, and
> there is no human-labelled gold set yet."
