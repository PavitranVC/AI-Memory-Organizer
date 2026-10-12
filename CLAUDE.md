# Instructions for Claude

Project: AI Memory Organizer. Node.js + Express + Mongoose (MongoDB) backend.
The plan, stages and branch names are in `docs/ROADMAP.md`. Read it first in
every session.

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
- The container is temporary. Only pushed commits survive.
