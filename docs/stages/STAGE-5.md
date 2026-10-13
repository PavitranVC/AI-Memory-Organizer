# Stage 5: Real datasets (viva notes)

Pull request: "Stage 5: Real datasets" into `main`. It is **stacked on the Stage 3 PR** (#4, which is stacked on
Stage 2, #3): merge Stage 2, then Stage 3, then this one.

This was the "5-lite" version from `docs/OVERNIGHT_PLAN.md`: LoCoMo and the synthetic generator are done;
LongMemEval, WildChat, PII scrubbing and the annotation tool are **not** (see section 5).

## 1. In one paragraph
Until now the database only held a handful of invented seed users, which is not enough to test the thesis. Stage 5
brings in **data that other people can check**: the LoCoMo benchmark (10 long two-person conversations with 1,986
labelled questions) is downloaded, verified by its SHA-256 hash, and loaded into our own collections as users,
conversations and messages, while its gold answers go to a separate `evalitems` collection that the app never
reads. It also adds a **synthetic generator** that creates 10k to 1M realistic-shaped memories (with supersede
chains and retractions) for the index experiments. Every loaded document carries a `dataset` label (`benchmark`,
`synthetic`, later `real`) and its original id, so benchmark, synthetic and real data can never be mixed up, and
any row can be traced back to the source file. This is the input Stage 6 needs: LoCoMo for accuracy, synthetic
data for performance.

## 2. What changed
| File | Why |
|---|---|
| `models/dataset.js` | The shared `dataset` field (`real` / `benchmark` / `synthetic`) and the `source` sub-document (dataset name, original id, session, speaker, date) |
| `models/User.js`, `models/Conversation.js`, `models/Message.js` | `dataset` and `source` fields. User gets a unique partial index on `(source.name, source.id)` so a sample is loaded once |
| `models/Memory.js` | `dataset` field (synthetic memories, and memories extracted from benchmark chats) |
| `models/EvalItem.js` | New `evalitems` collection: question, gold answer, adversarial answer, category, question type, evidence ids and the matched message ids. Unique on `(source.name, source.id, source.index)` |
| `services/datasets/locomo.js` | The LoCoMo loader: date parsing, evidence clean-up, mapping to our schema, one transaction per sample, skip or reset |
| `services/datasets/synthetic.js` | The synthetic generator: seeded, version chains like a real supersede, batched inserts, reset and remove |
| `services/datasets/common.js` | `removeUsers` (deletes dataset users and everything that references them) and a seeded random generator |
| `services/memoryService.js` | A memory created from a conversation copies that conversation's `dataset` label; a new version keeps it. Clients cannot set it |
| `services/userService.js` | Deleting an account also deletes its `evalitems` (no dangling references) |
| `scripts/datasets/download.js` | `npm run data:download`: downloads to `data/`, checks SHA-256, reports a blocked host by name and carries on, `--from` for a manual download |
| `scripts/datasets/load-locomo.js` | `npm run data:load:locomo` (`--reset`, `--file`) |
| `scripts/datasets/generate-synthetic.js` | `npm run data:synthetic -- --memories N [--users] [--seed] [--reset]`, or `--remove` |
| `scripts/datasets/stats.js` | `npm run data:stats`: file checks and counts per label, written to `results/stage5-dataset-stats.json` |
| `scripts/explain.js` | Lists the `evalitems` indexes, and explains queries for an app user, not a dataset user |
| `seed.js` | Also empties `evalitems` |
| `tests/datasets-locomo.test.js`, `tests/datasets-synthetic.test.js`, `tests/fixtures/locomo-mini.js` | 16 tests. The fixture is a **hand-written** sample in LoCoMo's format, not LoCoMo data |
| `tests/helpers.js`, `tests/users.test.js` | Register `EvalItem`; account deletion reports `evalItems` |
| `results/stage5-locomo-load.txt`, `results/stage5-synthetic-generate.txt`, `results/stage5-dataset-stats.json` | Output of the real runs, with command, commit, date and dataset |
| `docs/DATASETS.md` | Source, licence, citation, mapping, counts and limitations of each dataset |
| `.github/workflows/ci.yml` | CI downloads and loads LoCoMo twice (must skip the second time), generates 10k synthetic memories, then re-runs `explain` |
| `.gitignore`, `.env.example`, `package.json`, `README.md` | `data/` ignored; `DATA_DIR` and `HF_TOKEN`; the four `data:*` scripts; a Datasets section |

## 3. Concepts
| Idea | Textbook name | One line |
|---|---|---|
| `dataset` label on every row | **Data lineage / data provenance** | Each row records where it came from, so results can say exactly which data they used |
| `source.id` = LoCoMo's own id | **Natural key** kept next to a **surrogate key** | Our `_id` is the surrogate; the original id lets us join back to the source file |
| Gold answers in `evalitems`, not in memories | **Train/test separation (no label leakage)** | The system under test never sees the answers it is graded on |
| One transaction per sample | **Atomicity (ACID)** | A crash leaves a sample fully loaded or not at all |
| Skip if loaded, `--reset` to replace | **Idempotent load (ETL)** | Running the loader twice gives the same database as running it once |
| Download → map → load | **ETL: extract, transform, load** | The classic pipeline for moving external data into a database |
| SHA-256 of the file | **Checksum / data integrity** | Proves the file is byte-for-byte the one the results were computed on |
| Unique partial index on `(source.name, source.id)` | **Partial index** | Only dataset users are indexed; API users without a source cost nothing |
| Evidence ids → message ids | **Entity resolution** (simple, exact) | Turns the benchmark's text references into real foreign keys we can check |
| Delete dataset users "last" | **Ordering for crash safety** | A half-finished reset can be finished by running it again |
| Seeded generator (mulberry32) | **Pseudo-random number generator with a seed** | Same seed, same data: experiments can be repeated exactly |
| 80/15/5 % chains, 3% retracted | **Synthetic workload modelling** | Data shaped like the real thing so index results are meaningful |
| Batched `insertMany` without validation | **Bulk loading** | Far faster than one insert per document; correctness is checked by tests instead |
| Category numbers → names, checked on the data | **Data profiling** | We verified what the numbers mean from the data instead of assuming |

## 4. Examiner questions
1. **Why not just store LoCoMo as one big JSON document?**
   Because the system under test reads conversations and messages through the same collections and indexes as real
   users. Loading into those collections tests the real code path; one JSON blob would test nothing.
2. **How do you stop benchmark answers from leaking into the memory system?**
   The answers live only in `evalitems`, which no route or service of the app reads. Only the Stage 6 evaluation
   reads it, after the system has answered.
3. **What happens if the loader crashes halfway?**
   Each sample is inserted in one transaction, so it is either fully there or not there. Re-running the loader
   loads what is missing and skips what is complete.
4. **How do you know `category: 2` means "temporal"?**
   LoCoMo only gives numbers. We checked the data with a committed script: 76.6% of category-2 questions start with
   "When" against at most 1.4% elsewhere; 98.2% of category 1 cite several turns (multi-hop); only category 5 has
   adversarial answers. Category 3 is not separated by these checks, so the mapping is marked "TODO: verify"
   against the authors' code.
5. **LoCoMo is a chat between two people. How does that fit a user-assistant schema?**
   The first speaker is stored as `user`, the second as `assistant`, with real names kept in `source.speaker`. It is
   a known mismatch: our extractor only mines `user` messages, so Stage 6 must decide how to handle the second
   speaker. It is documented as a weak point.
6. **Why is synthetic data allowed at all, given the honesty rules?**
   Only for performance: index and scale timings depend on data size and shape, not meaning. Every document is
   labelled `synthetic` and is never used for accuracy.
7. **How is the synthetic data realistic?**
   It reproduces the schema's real structure: version chains linked exactly as `updateMemory` does
   (`validTo` = next `validFrom`, `supersedes` / `supersededBy`), retracted versions, categories, sensitivities and
   time-ordered `_id`s. The tests check that the chains are consistent and that the documents pass the schema.
8. **Why insert synthetic data without Mongoose validation?**
   Speed: 100k documents took 7.3 s in batches; one-by-one validated inserts would be much slower for 1M. The
   tests validate a sample of generated documents against the `Memory` schema instead.
9. **How can someone reproduce your data?**
   The download checks the file's SHA-256 (recorded in the script and in `DATASETS.md`), the synthetic generator is
   seeded, and every `results/` file records the command, commit and date.
10. **Some LoCoMo evidence ids are broken. What do you do?**
    They are normalised only when the intended id is obvious (`"D:11:26"` → `D11:26`, `"D8:6; D9:17"` → two ids).
    The rest are kept in `unresolvedEvidence` (3 in the whole file), never guessed. The original text stays in
    `evidence`.

## 5. Weak points
- **Only one benchmark.** LongMemEval and WildChat are on Hugging Face, which is blocked in the cloud session.
  There is no loader for them. *Answer:* "LoCoMo is the standard benchmark for long-term conversational memory; the
  download script already reports the blocked host, and the loaders are the next step once we have the files."
- **Not done: PII scrubbing, the seeded sampler, the annotation tool, the annotation guidelines and Cohen's kappa.**
  They all depend on WildChat. *Answer:* "They were deliberately not built without the real data; building a
  scrubber against data we cannot see would be guesswork."
- **LoCoMo is small** (10 conversations, 96 open-domain questions), so per-type results will have wide confidence
  intervals. *Answer:* "That is why Stage 6 reports bootstrap confidence intervals."
- **Speaker mapping.** Facts said by the second speaker are not extracted by the current extractor. *Answer:* "It
  is documented; Stage 6 can extract from both speakers or run the extraction once per speaker."
- **Times.** Session times have no time zone (read as UTC) and turns are spaced one second apart. *Answer:* "Only
  the order within a session is known; LoCoMo's temporal questions are about dates, not minutes."
- **Category names are our reading**, checked on the data but not yet against the authors' code.
- **Synthetic text is template text**, so the text index is smaller than with real text, and there are no
  synthetic messages, so provenance storage is not part of the scale numbers.
- **Reset deletes the dataset users' LLM-call logs too** (like deleting an account). Run `npm run llm:costs`
  before a reset if you need those numbers.
- **The loaded LoCoMo users all share `SEED_PASSWORD`**: development only.

## 6. Demo on your laptop
Needs MongoDB running as a replica set (see `STAGE-2.md`) and internet access to raw.githubusercontent.com.

```powershell
git checkout claude/stage-5-datasets   # or main, once merged
npm install
npm test                                # all pass; 323 tests on main since Stage 3b (mock only, no key)
npm run seed                            # empties the database first
npm run data:download                   # saves data\locomo\locomo10.json, "hash verified"
npm run data:load:locomo                # 10 samples: 272 sessions, 5882 messages, 1986 questions
npm run data:load:locomo                # again: every sample "skipped" (idempotent)
npm run data:synthetic -- --memories 10000
npm run data:stats                      # counts per label -> results\stage5-dataset-stats.json
npm run explain                         # still no collection scans
npm start
```

Second PowerShell window: log in as a LoCoMo user and look at the data through the normal API.
```powershell
$b = 'http://localhost:5000'
$login = Invoke-RestMethod -Method Post -Uri "$b/api/auth/login" -ContentType 'application/json' -Body '{"email":"locomo-conv-26@benchmark.invalid","password":"DevPassword123"}'
$h = @{ Authorization = "Bearer $($login.token)" }
$convs = (Invoke-RestMethod "$b/api/conversations?limit=3" -Headers $h).conversations
$convs | Format-Table title, dataset
(Invoke-RestMethod "$b/api/conversations/$($convs[0]._id)/messages?limit=5" -Headers $h).messages | Format-Table role, sentAt, content
```

The gold answers are not reachable through the API at all. Show them in the MongoDB shell instead:
```powershell
mongosh aimemory --quiet --eval "db.evalitems.aggregate([{`$group:{_id:'`$questionType',n:{`$sum:1}}}])"
mongosh aimemory --quiet --eval "db.evalitems.findOne({questionType:'temporal'},{question:1,answer:1,evidence:1})"
mongosh aimemory --quiet --eval "db.memories.countDocuments({dataset:'synthetic'})"
```

Clean up the synthetic data afterwards: `npm run data:synthetic -- --remove`.
