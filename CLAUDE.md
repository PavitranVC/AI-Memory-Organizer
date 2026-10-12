# Instructions for Claude

Project: AI Memory Organizer. Node.js + Express + Mongoose (MongoDB) backend.
The plan, stages and branch names are in `docs/ROADMAP.md`. The exact task for
each stage is its prompt in `docs/PROMPTS.md`. Read both first in every
session.

## Branches
- One branch per stage, named exactly as in the roadmap table
  (`claude/stage-N-<slug>`). Never commit or push to `main`.
- Start a stage from `main` if its parent stage is merged, otherwise from the
  parent stage's branch. Bring parent changes in with `git merge`. Never
  rebase, amend or force-push a pushed branch.
- Stay inside the current stage's scope. Note unrelated issues in the PR
  description instead of fixing them.
- Open a PR only when the user asks. One PR per stage, targeting `main`.
  The description says what changed, how to run it, and what the student
  should be able to explain.

## Stage notes (every stage)
Write `docs/stages/STAGE-N.md` for the student, who must defend the work in a viva. Use plain language and
these sections:
1. **In one paragraph**: what the stage does and why it matters for the project.
2. **What changed**: every file added or changed, one line each on why.
3. **Concepts**: each DB/AI idea used, with its textbook name and a one-line explanation.
4. **Examiner questions**: 10 likely questions, each with a short model answer.
5. **Weak points**: the honest limitations and how to answer if asked.
6. **Demo on your laptop**: exact Windows PowerShell commands to run and show it.
Keep the notes in sync with the code. If the code changes, update them in the same PR.

## Context budget
The context window is the scarcest resource in a long run. Spend it on decisions, not on output.
- **Short command output.**
  - Tests: `npm test 2>&1 | tail -40`. On a failure, rerun only the failing file.
  - Long logs: `| tail` or `| grep`, never the whole thing.
- **Never read data into context.** No `cat` of datasets, `results/` CSVs, lockfiles or large JSON. Inspect them
  with a small `node -e` script that prints counts, keys or a few sample rows (capped).
- **Long jobs write to files.** Benchmarks, downloads and evaluations write to `results/` or a log file and
  print a short summary.
- **Read narrowly.** Use Grep to find code, then Read only the lines needed. Don't re-read a file you just
  edited.
- **Keep state on disk, not in memory.** After every stage or major step, update the "Next step" line in
  `docs/OVERNIGHT_REPORT.md` (or the PR description in a normal session) and push.
- **After compaction**, first re-read this file, `docs/OVERNIGHT_REPORT.md`, `git status` and
  `git log --oneline -10`, then continue. A SessionStart hook in `.claude/settings.json` prints these
  automatically.
- **One stage per context.** In multi-stage runs, each stage is done by its own subagent, and the coordinator keeps
  only each stage's short summary.

## Unattended runs
When running without the user (for example the overnight plan in `docs/OVERNIGHT_PLAN.md`): never stop to
ask, make no paid API calls unless the prompt explicitly allows them, push after every logical step, and record
anything that needs the user in `docs/OVERNIGHT_REPORT.md`.

## Before every push
- `npm test` passes against a real MongoDB. In a cloud session, start one
  with `dockerd &` then `docker run -d -p 27017:27017 mongo:7`.
- `npm run seed` and `npm start` still work.
- README and `.env.example` are updated for any new command, variable or
  endpoint.

## Code conventions
- Match the existing style: CommonJS, 2-space indent, single quotes,
  semicolons, short comments explaining *why*.
- Routes stay thin. Database and AI logic goes in `services/`.
- Validate every reference (`userId`, `categoryId`, `conversationId`) in the
  service layer, since MongoDB has no foreign keys.
- Every query is scoped to the authenticated user.

## LLM and external services
- All LLM and embedding calls go through `services/llm/` and
  `services/embeddings/`. Every provider has a deterministic mock, and tests
  use the mock only. CI must never need an API key.
- Read model IDs and keys from environment variables. Never hard-code or
  commit secrets.

## Data and results honesty (non-negotiable)
- Every dataset is labelled `real`, `benchmark` (LoCoMo, LongMemEval) or
  `synthetic`. Synthetic data is used only for performance/scale tests and is
  never reported as real.
- Every number in docs, charts or the paper comes from a committed script run.
  Save it in `results/` with the command, git commit, date and dataset.
  Never invent, round up or "estimate" a result.
- Report results that do not favour the thesis too.
- Model pre-labels are never presented as human annotations.
- Cite only papers and datasets whose details have been checked. Mark
  anything unverified as `TODO: verify`.

## Environment facts (cloud session, checked Oct 2026)
- Reachable: npm, PyPI, Docker Hub, raw.githubusercontent.com (LoCoMo data),
  api.anthropic.com.
- Blocked: huggingface.co (LongMemEval, WildChat) and fastdl.mongodb.org
  (`mongodb-memory-server` downloads). Use Docker `mongo:7` instead.
- Pushing `claude/stage-*` branches works (verified).
- The container is temporary. Only pushed commits survive.
