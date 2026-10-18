# Local Setup: Claude Code on your laptop

This setup lets **Claude Code on your own laptop** change the code, run the tests, run the Ollama models and push to
GitHub. All of it is covered by your Claude subscription plus free local models, with no API key.

Target machine: Windows 11, 32 GB RAM, RTX 5070 Ti (12 GB VRAM), PowerShell.

## Requirements
| # | What | Why | Check it with |
|---|---|---|---|
| 1 | **Node.js 20+** | Runs the app and tests | `node -v` |
| 2 | **Git for Windows** | Version control. Includes Git Credential Manager, which signs you in to GitHub | `git --version` |
| 3 | **GitHub sign-in** for Git | So `git push` works without typing a password | `git push` succeeds (step 3 below) |
| 4 | **GitHub CLI** (`gh`, optional) | Lets Claude open pull requests and read CI results | `gh auth status` |
| 5 | **Claude Code** | The agent that does the work, signed in with your Claude account (subscription, not an API key) | `claude --version` |
| 6 | **MongoDB 7 or 8 as a replica set** | Transactions from Stage 2 onward need a replica set | `mongosh --eval "rs.status().ok"` prints `1` |
| 7 | **Ollama** with three models | Free local AI | `ollama list` |
| 8 | **Disk space** | Models (about 19 GB, already mostly downloaded) plus datasets and benchmark data (a few GB) | |

## One-time setup (with good internet)

**1. Install the tools** you don't have yet: Node.js LTS (nodejs.org), Git for Windows (git-scm.com), GitHub CLI
(cli.github.com), Ollama (ollama.com) and Claude Code (see claude.com/claude-code for the current Windows install
command). Close and reopen PowerShell afterwards.

**2. Pull the embedding model** (your two chat models are already installed):
```powershell
ollama pull nomic-embed-text
ollama list      # qwen2.5-coder:14b, deepseek-r1:14b, nomic-embed-text
```

**3. Sign Git and gh in to GitHub** (a browser window opens once):
```powershell
gh auth login                    # choose GitHub.com, HTTPS, "Login with a web browser"
gh auth setup-git                # lets git push use the same login
cd C:\Education\VIT\Projects\AI-Memory-Organizer
git config user.name  "Your Name"
git config user.email "your-github-email@example.com"
git fetch origin                 # must work without asking for a password
```

**4. Make MongoDB a replica set.** This is needed from Stage 2 onward; follow the exact steps in
`docs/stages/STAGE-2.md`. Afterwards `mongosh --eval "rs.status().ok"` should print `1`.

**5. Project `.env`** (the project folder, never committed):
```
MONGO_URI=mongodb://127.0.0.1:27017/aimemory_stage1
JWT_SECRET=<your long random value>
LLM_PROVIDER=ollama
EMBEDDING_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:14b
JUDGE_MODEL=deepseek-r1:14b
OLLAMA_EMBED_MODEL=nomic-embed-text
```
If Stage 2 changes the connection string for the replica set, follow its notes. `npm test` ignores these settings
and always uses the mocks, so the tests pass whether Ollama is running or not. All Ollama settings (context
window, timeout) are in `.env.example`; what each one does is explained in `docs/stages/STAGE-3B.md`.

If you switch from the default `lexical` embedder to `EMBEDDING_PROVIDER=ollama` on a database that already has
memories, re-embed them once: `npm run embed:backfill` (the vectors change from 256 to 768 numbers).

**6. Start Claude Code in the project:**
```powershell
cd C:\Education\VIT\Projects\AI-Memory-Organizer
claude
```
Sign in with your Claude account when asked. Claude reads `CLAUDE.md` automatically. The project's
`.claude/settings.json` pre-approves routine commands (npm, git, ollama, docker, gh) and blocks force-push, rebase and
pushing to `main`. Anything else, it will ask you about first. Those rules use Bash command syntax. If Claude Code
runs commands through PowerShell on your machine, some of them may not match, and it will ask more often; that is safe.

## Check that everything works
Paste this as the first message in Claude Code (Sonnet 5.5, medium effort):
```text
Check my local setup for this project and report a pass/fail table. Do not change any files.
1. node -v (need 20+), git --version, gh auth status, claude --version
2. git fetch origin works without a password prompt
3. MongoDB: connect to MONGO_URI from .env; report the version and whether it's a replica set
4. ollama list shows qwen2.5-coder:14b, deepseek-r1:14b and nomic-embed-text; then send one short JSON test prompt
   to qwen2.5-coder:14b through http://localhost:11434 and report the response time and whether it used the GPU
   (ollama ps)
5. npm install and npm test (show only the final Tests: line)
6. npm run test:live with LLM_PROVIDER=ollama: report the extracted memories, tokens and time (this is free)
For anything that fails, give me the exact fix.
```

## Line endings (Windows)
The repository keeps LF line endings (`.gitattributes`). A checkout made before that file existed may still have
CRLF files from `core.autocrlf=true`. The code copes with both, but to get clean LF files run this once, with no
uncommitted changes (`git status` must be clean): `git rm --cached -r -q .` then `git reset --hard`.

## Viva demo
When the setup above works, rehearse and present with **[DEMO.md](DEMO.md)**: a single PowerShell guide (checklist, API, supersede,
`/api/ask`, privacy, where the results are, fallbacks and a 2-minute script).

## Study commands (Claude Code)
Two custom slash commands in `.claude/commands/` help you prepare for the viva and keep the docs honest. Type them
in Claude Code inside the project folder:

| Command | What it does | Edits files? |
|---|---|---|
| `/viva <stage>` | Stage is `1`, `2`, `3`, `3b`, `4`, `5`, `6` or `7`. Reads `docs/stages/STAGE-<stage>.md` and the code it describes, asks the 10 examiner questions one at a time (waits for your answer, corrects it briefly), then 3 follow-up questions, and ends with a list of what to re-read | Never |
| `/sync-docs` | Compares the code with `README.md` and every `docs/stages/STAGE-*.md`, lists what is outdated or wrong, fixes it on a new branch `claude/docs-sync-<date>`, runs `npm test`, pushes and opens a PR | Yes, on its own branch only, never `main` |

Sonnet 5.5 at medium effort is enough for `/viva`; use high effort for `/sync-docs`. `/sync-docs` needs `gh`
signed in (step 3) to open the pull request.

## Ollama speed tips (12 GB VRAM)
- A 14B model (about 9 GB) fits on the GPU with the small context window (`OLLAMA_NUM_CTX=8192`). The full-context
  baseline needs the large one (`OLLAMA_NUM_CTX_LARGE=32768`), whose memory may push part of the model to the CPU:
  those answers are much slower. `ollama ps` shows the GPU/CPU split.
- Setting the Windows environment variables `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0` (then
  restart Ollama) roughly halves the memory of the context window. TODO: verify on your Ollama version.
- The answer model and the judge are different models and both do not fit in 12 GB at once, so Ollama swaps them.
  The pilot's `timing.json` measures what that costs; `npm run eval:cost -- --provider ollama --pilot ...` turns it
  into hours for the full run.

## Long local runs (for example the full evaluation overnight)
- **Power:** plug the laptop in. Under Settings → System → Power, set screen and sleep to "Never" while it runs.
- **Internet:** not needed once the models are downloaded, except for the final `git push`. If you're offline,
  Claude commits locally and you push in the morning with `git push`.
- **Heat:** a long GPU run is fine on a Legion. Keep the vents clear and use the Performance mode (Fn+Q).
- **Usage:** Claude Code uses your subscription limits; the Ollama work itself costs nothing. A long evaluation
  mostly waits on Ollama, so it uses little of your Claude limit. Claude starts the job, it writes results to files,
  and Claude checks them.
- **Context:** the "Context budget" rules in `CLAUDE.md` apply here too. Use `/context` to check, and start a new session per
  stage.
