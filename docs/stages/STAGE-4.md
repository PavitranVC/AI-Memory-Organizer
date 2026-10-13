# Stage 4: Hybrid retrieval (viva notes)

Pull request: "Stage 4: Hybrid retrieval" into `main`. It is **stacked on the Stage 5 PR** (#5, stacked on Stage 3
#4, stacked on Stage 2 #3): merge Stage 2, then Stage 3, then Stage 5, then this one.

This was the "4-lite" version from `docs/OVERNIGHT_PLAN.md`: the local vector backend, the offline lexical
embedder and the mock are used and tested; the Voyage provider and the Atlas backend are written but **not run**
(see section 5).

## 1. In one paragraph
Stages 2 and 3 store memories well, but the assistant still had no good way to *use* them: keyword search misses
reworded questions and knows nothing about time. Stage 4 adds **retrieval**: every memory version gets an
**embedding** (a vector of numbers describing its text), and a question is answered from the few memories that
score best on four things at once: keyword match, vector similarity, how recent the fact is, and how important it
is. Crucially, the **time filter comes first**: only facts that were valid at the question's date (`asOf`,
default now) can be retrieved, so a superseded fact ("Lives in Pune") can never answer "Where do I live?" today,
but it does answer "Where did I live in 2022?". `POST /api/ask` then sends only the top-k memories to the LLM and
returns the answer with **citations** to the memories it used. This is the part of the system the Stage 6
evaluation will measure against overwrite-style memory and plain RAG, so it is the bridge from "a good database"
to "a better assistant".

## 2. What changed
- `services/embeddings/hashing.js`: tokenizer, FNV-1a hash, normalisation and cosine similarity shared by the offline embedders.
- `services/embeddings/mockProvider.js`: deterministic 64-number test double used by every test.
- `services/embeddings/lexicalProvider.js`: the default offline embedder (hashed words and character trigrams, 256 numbers), labelled a **lexical baseline, not a semantic model**.
- `services/embeddings/voyageProvider.js`: Voyage AI semantic embeddings over HTTPS, only with `VOYAGE_API_KEY`; not run.
- `services/embeddings/config.js`, `index.js`: picks the provider from `EMBEDDING_PROVIDER`, checks vector sizes, and embeds a memory version without ever blocking its write.
- `services/embeddings/backfill.js`, `scripts/embed-backfill.js` (`npm run embed:backfill`): embeds old or missed memories, safe to re-run.
- `models/Memory.js`: new fields `embedding` (hidden from API responses) and `embeddingModel`.
- `services/memoryService.js`: create and update compute the new version's vector before the transaction; an unchanged text reuses the old vector.
- `services/auditService.js`: audit snapshots leave the vector out.
- `services/retrieval/config.js`: weights, top-k, candidate count, half-life, backend, all from `.env`.
- `services/retrieval/vectorStore.js`: one interface, two backends: local brute-force cosine, and the Atlas `$vectorSearch` pipeline.
- `services/retrieval/index.js`: the hybrid ranking, filtered by valid time, plus the access-count update.
- `services/askService.js`, `routes/ask.js`: `POST /api/ask` (retrieve top-k, answer, check citations).
- `routes/memory.js`: `GET /api/memories/retrieve` shows the ranking without the LLM.
- `prompts/answer.v1.md`, `services/llm/*`: the new `answer` task (versioned prompt, JSON schema, mock answer, citation check, `ANSWER_MODEL`).
- `services/extractionService.js`: reconciliation finds similar memories with hybrid retrieval (text + vector) instead of keyword search only.
- `atlas/vector-index.json`, `scripts/atlas-index.js` (`npm run atlas:index`): the Atlas index definition and a script to create it.
- `scripts/bench-retrieval.js` (`npm run bench:retrieval`), `results/stage4-retrieval-latency.csv/.txt`: latency p50/p95 at 1k and 10k synthetic memories.
- `scripts/explain.js`: checks the retrieval candidate queries use indexes.
- `seed.js`: embeds the seeded memories.
- `tests/embeddings.test.js`, `tests/retrieval.test.js`, `tests/ask.test.js`, `tests/fixtures/atlasEmulator.js`: 40 more tests than Stage 5 (209 to 249); `tests/setupEnv.js` forces the mock embedder.
- `.github/workflows/ci.yml`: runs the backfill twice, prints the Atlas index, and smoke-runs the benchmark.
- `README.md`, `.env.example`: new endpoints, variables, commands and the Atlas setup steps.

## 3. Concepts
- **Embedding / vector space model**: text turned into a fixed-length vector so that similar texts have nearby vectors.
- **Cosine similarity**: the cosine of the angle between two vectors (1 = same direction, 0 = unrelated); length-independent.
- **Feature hashing (the hashing trick)**: hash each word into one of N buckets, so no vocabulary table is needed (Weinberger et al., 2009).
- **Character n-grams**: overlapping 3-letter pieces of words, so "live" and "lives" still share features.
- **Sublinear term frequency**: weight = 1 + log(tf), so a repeated word does not dominate.
- **Lexical vs semantic retrieval**: lexical matches the same words; semantic matches meaning (needs a trained model such as Voyage).
- **Exact (brute-force) k-nearest-neighbour search**: compare the query with every vector; exact but O(n).
- **Approximate nearest neighbour (ANN), HNSW**: the graph index behind Atlas `$vectorSearch`; sub-linear but approximate.
- **Pre-filter vs post-filter**: filtering before the vector search (fewer rows, index support needed) or after it (may return fewer than k).
- **Hybrid retrieval / score fusion**: a weighted sum of normalised scores from several rankers (here text, vector, recency, importance).
- **Min-max normalisation**: the text score is divided by the best text score so every part lies in [0, 1].
- **Exponential decay**: recency = 0.5^(age / half-life).
- **Valid-time selection (bi-temporal "as of" query)**: only facts true at time T; the Stage 2 filter reused as a retrieval filter.
- **Retrieval-augmented generation (RAG)**: retrieve relevant records, then let the LLM answer from them only.
- **Grounding and citations**: the answer names the records it used, and the server checks them.
- **Top-k context budget**: only k memories go to the model, so cost does not grow with the size of the memory store.
- **Derived data**: the vector is like an index entry: recomputable, written in place, not a change of belief, so no new version and no audit row.
- **Test double and emulator**: the mock embedder and the Atlas emulator stand in for services CI cannot reach.

## 4. Examiner questions
1. **What is "hybrid" about your retrieval?** It combines four signals: MongoDB's text score, cosine similarity of
   embeddings, recency and importance, as `0.4*text + 0.4*vector + 0.1*recency + 0.1*importance` (weights in `.env`),
   each normalised to [0, 1].
2. **How do you make sure an outdated fact is not used?** The valid-time filter from Stage 2 (`validFrom <= T <
   validTo`, not retracted) is part of both candidate queries, so a superseded version is never a candidate for a
   question about a later date. A test checks "Where do I live?" returns Mumbai now, Pune in 2022 and nothing in 2019.
3. **Why not just use vector search?** Exact names, numbers and rare words are matched better by keywords; vectors
   match rephrasings. Each covers the other's blind spot, and the parity of both lists is cheap to compute.
4. **Is your embedder semantic?** The default one is not: it is a lexical baseline (hashed words and trigrams), chosen
   because it is offline and free. "flat" does not match "apartment" (a test documents this). The Voyage provider is
   semantic but was not run, because it costs money.
5. **How does the local backend work and how does it scale?** It reads every memory of that user that passes the time
   filter (through the normal indexes) and computes cosine in Node: exact but linear. Measured p95 for one call:
   50.39 ms at 1,000 memories and 322.24 ms at 10,000 (synthetic, one user, `results/stage4-retrieval-latency.csv`).
6. **What does Atlas change?** `$vectorSearch` uses an HNSW index: approximate but sub-linear. It can only pre-filter
   on fields declared in the index (`userId`, `embeddingModel`, `validFrom`); the rest of the time filter runs as a
   `$match` afterwards, with 4x over-fetching to make up for dropped rows.
7. **How did you test Atlas without Atlas?** An emulator checks our pipeline against the committed index JSON (index
   name, path, declared filter fields, numCandidates limits) and evaluates it exactly; tests then require identical
   ids, order and scores from both backends. It caught a real bug (the local backend was not loading vectors).
8. **How do you stop the model inventing citations?** Memories are shown as labels `m1..mk`; the answer must cite
   labels, and any label not shown makes the request fail with 502. Labels map back to ids on the server.
9. **What happens if the embedding service is down?** Writes still succeed without a vector (`embeddingModel: null`) and
   `npm run embed:backfill` fills them in later; a question is answered from keywords only with a warning.
10. **Why is reading a memory an update?** `lastAccessedAt` and `accessCount` are usage bookkeeping, updated in place
    (no new version, `updatedAt` untouched). Reconciliation uses `touch: false`, because the extractor looking at a
    memory is not the user using it.

## 5. Weak points
- **No semantic model was run.** All retrieval tonight is lexical (or the mock). Say: "The architecture is
  provider-independent and stores the model id per vector; quality claims need the Voyage run, which is a paid step
  left for the user."
- **The weights (0.4/0.4/0.1/0.1), the half-life (90 days) and the lexical cut-off (0.3) are not tuned.** The cut-off
  was chosen by looking at the seed data (unrelated sentences scored 0.1 to 0.2). Say: "They are configuration;
  Stage 6 should tune them on a development split, not on the test questions."
- **Recency is measured from `validFrom`.** A long-standing current fact ("lives in Bengaluru since 2024") scores lower
  on recency than a fact recorded yesterday. With weight 0.1 it rarely flips the order, but it can.
- **Brute force is linear.** 10k memories for one user took about a third of a second at p95 on the cloud container.
  Atlas (ANN) is the answer, but it was not measured here.
- **Atlas was never run.** The pipeline is only checked against our own emulator, and whether `$vectorSearch` filters
  accept `null` is marked TODO: verify (we avoided relying on it).
- **Vectors are big.** A 256-number vector stored as BSON doubles is about 2.36 KB, 82% of an average memory
  document (2,355 of 2,858 bytes in the benchmark); every version keeps its own copy. Binary float32 vectors would
  cut this; not done.
- **The mock answer model does not read the question**: it always cites the top-ranked memory. It proves wiring, not
  quality.
- **The latency numbers are one run** on a shared 4-CPU cloud container with MongoDB on the same machine, on
  synthetic data with all memories owned by one user (the worst case for brute force).
- **Voyage cost and token usage are not logged** in `llmcalls` (only LLM calls are).

## 6. Demo on your laptop
Needs MongoDB running as a replica set (see `STAGE-2.md`). No API key: the mock LLM and the lexical embedder are used.

```powershell
git checkout claude/stage-4-hybrid-retrieval   # or main, once merged
npm install
npm test                                # 249 tests, no API key needed
npm run seed                            # also embeds every memory: "Embedding model: lexical-hash-v1-256"
npm run embed:backfill                  # nothing left to do: "embedded":0
npm run explain                         # retrieval queries use indexes, no collection scans
npm start
```

Second PowerShell window: ask Priya where she lives, now and in 2023 (she moved from Kochi to Bengaluru on 1 Aug 2024).
```powershell
$b = 'http://localhost:5000'
$login = Invoke-RestMethod -Method Post -Uri "$b/api/auth/login" -ContentType 'application/json' -Body '{"email":"priya.nair@example.com","password":"DevPassword123"}'
$h = @{ Authorization = "Bearer $($login.token)" }
# The ranking with its four parts (no LLM)
(Invoke-RestMethod "$b/api/memories/retrieve?q=Where%20do%20I%20live&k=3" -Headers $h).results | ForEach-Object { "{0:N3}  {1}" -f $_.score, $_.memory.content }
(Invoke-RestMethod "$b/api/memories/retrieve?q=Where%20do%20I%20live&asOf=2023-06-01" -Headers $h).results | ForEach-Object { "{0:N3}  {1}" -f $_.score, $_.memory.content }
# The answer with citations (mock LLM: it repeats the top memory)
$now = Invoke-RestMethod -Method Post -Uri "$b/api/ask" -Headers $h -ContentType 'application/json' -Body '{"question":"Where do I live?"}'
$now.answer; $now.citations | Format-Table label, content, validFrom, validTo
$then = Invoke-RestMethod -Method Post -Uri "$b/api/ask" -Headers $h -ContentType 'application/json' -Body '{"question":"Where do I live?","asOf":"2023-06-01"}'
$then.answer; $then.citations | Format-Table label, content, validFrom, validTo
# A question nothing answers: no LLM call at all
(Invoke-RestMethod -Method Post -Uri "$b/api/ask" -Headers $h -ContentType 'application/json' -Body '{"question":"What am I allergic to?"}') | Format-List answer, insufficient, llmCalled
```
In 2023 only the Kochi version can be retrieved; today the Kochi version is excluded and the Bengaluru one is in the
list. (Today the mock may cite "parents live in Kochi" first: it is current and recorded more recently, which is the
recency weak point above.)

Optional, the benchmark (about a minute; it uses its own `aimemory_bench` database and drops it):
```powershell
npm run bench:retrieval -- --sizes 1000,10000 --queries 200 --out results\my-laptop-latency
Get-Content results\my-laptop-latency.txt
```

Optional, Atlas: follow "Atlas vector search" in the README (`npm run atlas:index` against a free M0 cluster, then
`VECTOR_BACKEND=atlas`).
