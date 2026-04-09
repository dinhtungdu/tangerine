---
name: platform-setup
description: Set up Tangerine on the host machine or inside a VM — install tools, configure projects, clone repos, and install agent skills.
metadata:
  author: tung
  version: "1.1.0"
---

# Tangerine Init Skill

Set up the Tangerine coding agent platform. Tangerine can run directly on the host machine OR inside a Lima VM. Either way: one machine runs the server, dashboard, agents, and all project repos.

## Architecture (v1)

```
Host (laptop) — or VM (Lima)
├── tangerine server + dashboard (:3456)
├── {workspace}/project-a/0 (main clone)
│                          1 (task worktree)
│                          2 (task worktree)
├── {workspace}/project-b/0, 1, ...
├── agents (claude, opencode) — local processes
└── Apache, MariaDB, tools — shared
```
`{workspace}` defaults to `~/tangerine-workspace` but is configurable via `config.workspace` in `~/tangerine/config.json`.

No SSH tunnels, no per-project VMs. One machine, all projects.

## Setup Modes

### Mode 1: Host Machine Setup

User runs `/platform-setup` from their host machine (macOS or Linux) and wants to run Tangerine natively — no VM. You help them:

1. **Install prerequisites**

   Detect OS: `uname -s` → `Darwin` = macOS, `Linux` = Linux.

   **macOS** (use Homebrew; install brew first if missing):
   ```bash
   brew install git gh jq dtach node
   # Bun:
   curl -fsSL https://bun.sh/install | bash
   ```

   **Linux (Debian/Ubuntu)**:
   ```bash
   sudo apt-get update && sudo apt-get install -y git curl jq dtach
   # Node.js 22:
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
   sudo apt-get install -y nodejs
   # Bun:
   curl -fsSL https://bun.sh/install | bash
   # gh CLI:
   (type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y)) \
     && sudo mkdir -p -m 755 /etc/apt/keyrings \
     && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
     && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
     && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
     && sudo apt update && sudo apt install gh -y
   ```

2. **Install agent CLIs**:
   ```bash
   npm install -g @anthropic-ai/claude-code opencode-ai
   ```

3. **Clone tangerine**:
   ```bash
   mkdir -p ~/workspace
   git clone <tangerine-repo> ~/workspace/tangerine
   cd ~/workspace/tangerine && bun install
   ```

4. **Configure projects** (see Project Setup below)

5. **Install agent skills**:
   ```bash
   cd ~/workspace/tangerine
   bin/tangerine install
   ```

6. **Start server**:
   ```bash
   bin/tangerine start
   ```

### Mode 2: Fresh VM Setup (from host, Lima)

User runs `/platform-setup` from the HOST machine and wants a Lima VM. You help them:

1. **Create Lima VM** (if not exists):
   ```bash
   limactl start --name tangerine ~/workspace/tangerine/deploy/tangerine.yaml
   ```

2. **Run base setup** inside VM:
   ```bash
   limactl shell tangerine
   sudo bash /path/to/tangerine/deploy/base-setup.sh
   ```

3. **Clone tangerine** inside VM:
   ```bash
   cd ~/workspace
   git clone <tangerine-repo> tangerine
   cd tangerine && bun install
   ```

4. **Configure projects** (see Project Setup below)

5. **Install agent skills** inside VM (see Agent Skills below)

6. **Start server**:
   ```bash
   bin/tangerine start
   ```

### Mode 3: Project Setup (inside VM or on host)

User runs `/platform-setup` from inside the VM or on the host in a project directory. You help them add the project to Tangerine.

## Project Setup Workflow

1. **Get repo URL** from the user (and optionally a project name; default to the repo name).

2. **Read the workspace path** from the existing config (default `~/tangerine-workspace` if the file doesn't exist yet):
   ```bash
   [ -f ~/tangerine/config.json ] \
     && jq -r '.workspace // "~/tangerine-workspace"' ~/tangerine/config.json \
     || echo ~/tangerine-workspace
   ```
   Use this resolved path as `{workspace}` for all subsequent steps. Never hardcode `~/tangerine-workspace`.

3. **Clone the repo** into `{workspace}/{projectName}/0/`:
   ```bash
   mkdir -p {workspace}/my-project
   git clone <repo-url> {workspace}/my-project/0
   ```
   The `/0` directory is the **main branch clone** — it is never assigned to tasks. This path must match what `getRepoDir()` in `packages/server/src/config.ts` computes: `join(resolveWorkspace(config), projectId, "0")`.

4. **Scan the cloned repo** for stack indicators (see references/stacks.md):
   - Language runtimes and versions
   - Package managers
   - Frameworks and dev server configuration
   - Database/service dependencies
   - Test runners and commands
   - CI config (reveals required tooling)

5. **Present the plan** before writing:
   - Detected stack summary
   - Proposed project name
   - Clone path (`{workspace}/{projectName}/0`)
   - Setup command — **required**, ask the user if it cannot be detected
   - Test command
   - Post-update command (install deps + build, runs after git pull)

6. **Write config** to `~/tangerine/config.json`.

   **Required fields** (Zod schema enforces these — config will fail to load if missing):
   - `name` — project identifier
   - `repo` — git remote URL
   - `setup` — command run per-task in the worktree (e.g. `pnpm install`); **must ask the user** if not detectable from the codebase

   **Optional fields** (omit if not needed):
   - `test` — test command
   - `defaultBranch` — defaults to `"main"`
   - `defaultProvider` — `"claude-code"` | `"opencode"` | `"codex"`, defaults to `"claude-code"`
   - `model` — override the default LLM model
   - `env` — key/value pairs injected into agent environment
   - `postUpdateCommand` — runs after `git pull` (install + build)
   - `predefinedPrompts` — array of `{label, text}` quick-send buttons

   **Top-level optional fields** (outside `projects[]`):
   - `model` — default LLM model for new tasks
   - `models` — array of available model strings
   - `workspace` — base directory for clones/worktrees (default: `~/tangerine-workspace`)
   - `sshHost` — SSH hostname for editor deep-links (e.g. `"dev-vm"`). Must match a `Host` entry in `~/.ssh/config` on the host machine where the editor runs
   - `sshUser` — SSH username for Zed editor links (e.g. `"tung.linux"`)
   - `editor` — `"vscode"` | `"cursor"` | `"zed"` — enables "Open in editor" links in the dashboard

   The top-level config file is `{ "projects": [...] }`. On a fresh install, create the file with the project inside the array. On an existing install, append to `projects[]`. Example full config:
   ```json
   {
     "projects": [
       {
         "name": "my-project",
         "repo": "https://github.com/org/repo",
         "defaultBranch": "main",
         "setup": "pnpm install",
         "test": "pnpm test",
         "defaultProvider": "claude-code",
         "postUpdateCommand": "pnpm install && pnpm build"
       }
     ],
     "sshHost": "dev-vm",
     "sshUser": "tung.linux",
     "editor": "vscode"
   }
   ```

7. **Validate the config** after writing — catches missing required fields before the server starts:
   ```bash
   jq -e '.projects[-1] | (.name | length > 0) and (.repo | length > 0) and (.setup | length > 0)' ~/tangerine/config.json \
     && echo "Config valid" || echo "ERROR: missing required field (name, repo, or setup)"
   ```
   If validation fails, identify the missing field and ask the user to supply it before continuing.

### Base Setup Includes

The `deploy/base-setup.sh` installs these globally:
- git, curl, jq, dtach, unzip
- Node.js 22 LTS, npm, pnpm
- Bun runtime
- PHP CLI + common extensions, Composer
- OpenCode + Claude Code (pre-installed globally)
- gh CLI

## Agent Skills

Skills are installed by running `bin/tangerine install` inside the VM. This symlinks skill directories into each provider's configured skill directory, including Claude Code, Codex, OpenCode, and Pi.

```bash
# Inside the VM:
bin/tangerine install
```

This installs the built-in skills (`tangerine-tasks`, `platform-setup`, `browser-test`) for Claude Code, Codex, OpenCode, and Pi agents. For project-specific skills, install them manually:

```bash
ln -s /path/to/skill ~/.claude/skills/my-skill
ln -s /path/to/skill ~/.codex/skills/my-skill
ln -s /path/to/skill ~/.pi/agent/skills/my-skill
```

## Credentials

Credentials are set up ONCE in the VM environment, not managed per-task:

```bash
# LLM API keys (in ~/.env or shell profile)
export ANTHROPIC_API_KEY=sk-ant-...
# Or for Claude Code OAuth:
export CLAUDE_CODE_OAUTH_TOKEN=...

# gh CLI auth
gh auth login
```

## File Locations

```
~/tangerine/
  config.json             # all projects (managed by tangerine CLI)
  tangerine.db            # task database
~/tangerine-workspace/    # configurable via config.workspace
  project-a/
    0/               # main branch clone (never assigned to tasks)
    1/               # task worktree
    2/               # task worktree
  project-b/
    0/
    1/

~/workspace/tangerine/    # tangerine source code
  deploy/
    tangerine.yaml        # Lima VM template
    base-setup.sh         # common tool installation
```

## What to Ask the User

Only ask if you can't determine from the codebase:
- Repo URL (if no git remote found)
- Which agent skills to install

## After Init

```bash
# Start the server
bin/tangerine start

# Open browser
# http://localhost:3456 (forwarded from VM)

# Create tasks from dashboard or CLI
tangerine task create --project my-app --title "Fix bug"
```
