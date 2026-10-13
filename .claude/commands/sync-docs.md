---
description: Checks README.md and every docs/stages/STAGE-*.md against the code, fixes what is outdated on a new branch, runs the tests and opens a PR.
argument-hint: (no arguments)
---

Read `CLAUDE.md` first and follow it, especially "Context budget", "Data and results honesty" and "Before every
push". Your task: make the documentation match the code. The code is the truth; you change docs, not code.

**Hard rules**
- Never commit or push to `main`, never force-push or rebase, never merge a pull request.
- Change only `README.md`, `docs/stages/STAGE-*.md` and, if a stage note points to it, `.env.example`. If the
  code itself looks wrong, do not fix it: list it in the PR description under "Code issues found (not fixed)".
- Never invent, round or change a result number. A number in the docs must come from a file in `results/`; if it
  does not match that file, correct it to the file's value and say which file. If no file backs it, mark it
  `TODO: verify` instead of guessing.
- Keep each stage note's six sections ("Stage notes" in `CLAUDE.md`) and its plain style.

## 1. Start from the latest main
```bash
git fetch origin main
git status --short          # must be clean; if not, stop and tell me
```

## 2. Compare (read narrowly: Grep first, then only the lines you need)
Check every claim below against the code, in this order:
1. **Files**: every path named in README.md and in each note's "What changed" exists (`git ls-files`), and every
   file in `services/`, `routes/`, `models/`, `scripts/`, `eval/` and `prompts/` is mentioned somewhere it should be.
2. **npm scripts**: the README table matches `package.json` "scripts" (names and what they do).
3. **Environment variables**: the README table and `.env.example` match what the code reads (`process.env.X`,
   `env.X` in the config files) and the defaults in the code.
4. **Endpoints**: the README endpoint list matches `routes/` (method, path, auth).
5. **Data model and indexes**: fields and indexes described in the docs match `models/` (`schema.index(...)`).
6. **Behaviour claims**: providers, defaults, limits, retries and error codes that the notes describe match the
   code (e.g. the LLM and embedding providers in `services/llm/` and `services/embeddings/`).
7. **Tests**: test file names and counts quoted in the docs (run `npm test 2>&1 | tail -5` for the real count).
8. **Commands in "Demo on your laptop"**: they still exist and use the current script names and options.
9. **Examiner answers**: a model answer that the code now contradicts.

Then print a short table for me: `file | line | what is outdated or wrong | fix`. If nothing is outdated, say so,
stop, and create no branch.

## 3. Fix on a new branch
```bash
git checkout -b claude/docs-sync-$(date +%Y-%m-%d) origin/main
```
(in PowerShell the date is `Get-Date -Format yyyy-MM-dd`; if that branch already exists, add `-2`, `-3`, ...). Make the fixes from the table, one commit per file or per
topic, with messages that say what was outdated.

## 4. Check, push, open the PR
- `npm test 2>&1 | tail -40` must pass against MongoDB as a replica set (on the laptop: the local service; in a
  cloud session: `dockerd &` then `docker run -d -p 27017:27017 mongo:7 --replSet rs0` and `rs.initiate()`).
  A docs-only change cannot break tests; if they fail, report it and do not push.
- `git push -u origin claude/docs-sync-<date>`
- Open a pull request into `main` titled `Docs sync <date>: README and stage notes match the code`, with the
  table from step 2, the commits, the test result line, and "Code issues found (not fixed)" if any. Use
  `gh pr create`, or the GitHub tools if `gh` is not available.

End with: the PR link, the number of fixes, and anything I must check by hand.
