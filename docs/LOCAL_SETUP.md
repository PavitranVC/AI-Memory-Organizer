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
`docs/stages/STAGE-2.md` once it exists. Afterwards `mongosh --eval "rs.status().ok"` should print `1`.

**5. Project `.env`** (the project folder, never committed):
```
MONGO_URI=mongodb://127.0.0.1:27017/aimemory_stage1
JWT_SECRET=<your long random value>
LLM_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5-coder:14b
JUDGE_MODEL=deepseek-r1:14b
OLLAMA_EMBED_MODEL=nomic-embed-text
```
If Stage 2 changes the connection string for the replica set, follow its notes.

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
For anything that fails, give me the exact fix.
```

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
