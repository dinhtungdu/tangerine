---
name: platform-setup
description: Set up Tangerine on the host machine or inside a VM — install tools, configure projects, clone repos, and install agent skills.
metadata:
  author: tung
  version: "1.2.0"
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

## Routing

Before doing anything, figure out which mode applies:

1. **Check if Tangerine is already running** (`tangerine --version` or `~/tangerine/config.json` exists) → **Mode 3** (add a project).
2. **Check if we're inside a Lima VM** (`limactl info` fails or `uname -n` contains "lima") → **Mode 1** (set up Tangerine here).
3. **Check if the user is on macOS** (`uname -s` = `Darwin`) and `limactl` is available → ask: *"Do you want to run Tangerine directly on this machine or inside a Lima VM?"*
   - Direct → **Mode 1**
   - VM → **Mode 2**
4. **Otherwise** (Linux host, no VM) → **Mode 1**.

## Setup Modes

Two modes: **Tangerine Setup** (install and run Tangerine on the current machine) and **VM Creation** (create a Lima VM on macOS, then run Tangerine Setup inside it — the setup steps are identical once inside).

### Mode 1: Tangerine Setup (host or inside VM)

User is on the machine where Tangerine will run — either their host or inside a Lima VM. You help them:

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

2. **Verify agent CLIs are installed and authenticated**:
   ```bash
   which claude && claude --version
   which opencode && opencode --version
   ```
   Tangerine assumes agents are already installed and authenticated. If any are missing, install them (`npm install -g @anthropic-ai/claude-code opencode-ai`) and authenticate each before starting Tangerine — Tangerine does not manage credentials.

3. **Clone tangerine**:
   ```bash
   mkdir -p ~/workspace
   git clone <tangerine-repo> ~/workspace/tangerine
   cd ~/workspace/tangerine && bun install && bun link
   ```

4. **Configure projects** (see Project Setup below)

5. **Install agent skills** (once):
   ```bash
   cd ~/workspace/tangerine
   tangerine install
   ```

6. **Add a project** (required before starting — see Project Setup below):
   ```bash
   tangerine project add --name <name> --repo <url> --setup "<cmd>"
   ```

7. **Configure dashboard/API auth**.

   If Tangerine will bind a non-loopback host (the default `tangerine start` behavior) or the user wants shared dashboard/API access, set a shared token before starting:
   ```bash
   tangerine config set TANGERINE_AUTH_TOKEN=$(openssl rand -hex 32)
   ```
   This token is used for:
   - dashboard unlock screen
   - REST API bearer auth
   - task and terminal WebSocket auth
   - agent self-calls back into the Tangerine API

   Notes:
   - `GET /api/health` and `GET /api/auth/session` stay public
   - startup fails on non-loopback binds without `TANGERINE_AUTH_TOKEN` unless `TANGERINE_INSECURE_NO_AUTH=1` is explicitly set

8. **Enable HTTPS (optional)** — serves tokens over TLS, recommended when auth is enabled.

   Add an `ssl` block to `~/tangerine/config.json`:
   ```json
   {
     "ssl": {
       "cert": "/path/to/cert.pem",
       "key": "/path/to/key.pem",
       "port": 3443
     }
   }
   ```
   - `port` defaults to `3443` if omitted. Must differ from the HTTP port (3456).
   - For local use, generate a self-signed cert with openssl:
     ```bash
     openssl req -x509 -newkey rsa:4096 -keyout ~/tangerine/key.pem \
       -out ~/tangerine/cert.pem -days 365 -nodes \
       -subj "/CN=localhost"
     ```
   - When SSL is configured, both HTTP (3456) and HTTPS (3443) are served. The startup message shows both URLs.

9. **Start server**:
   ```bash
   tangerine start
   ```

### Mode 2: VM Creation (macOS host, Lima)

User wants a Lima VM to run Tangerine in. You help them create it, then they run Mode 1 inside:

1. **Write the Lima VM template** and start the VM:
   ```bash
   cat > /tmp/tangerine.yaml << 'EOF'
   # Tangerine Lima VM Template

   # Debian 13 (Trixie) cloud images
   images:
     - location: "https://cloud.debian.org/images/cloud/trixie/daily/latest/debian-13-generic-arm64-daily.qcow2"
       arch: "aarch64"
     - location: "https://cloud.debian.org/images/cloud/trixie/daily/latest/debian-13-generic-amd64-daily.qcow2"
       arch: "x86_64"

   # Apple Virtualization.framework for better perf on macOS
   vmType: "vz"
   vmOpts:
     vz:
       rosetta:
         enabled: true
         binfmt: true

   cpus: 4
   memory: "8GiB"
   disk: "20GiB"

   ssh:
     localPort: 0
     loadDotSSHPubKeys: true
     forwardAgent: true

   portForwards:
     - guestPort: 3456
       hostIP: "0.0.0.0"
       hostPort: 3456

   # Mount tangerine data — DB, config, credentials survive VM rebuilds.
   mounts:
     - location: "~/tangerine"
       mountPoint: "/home/$USER/tangerine"
       writable: true
     - location: "~/.config/gh"
       mountPoint: "/home/$USER/.config/gh"
       writable: false
   EOF
   limactl start --name tangerine /tmp/tangerine.yaml
   ```

2. **Shell into the VM**, install your coding agent(s), authenticate them, then run `/platform-setup`:
   ```bash
   limactl shell tangerine
   # Install your agent(s) of choice, e.g.:
   npm install -g @anthropic-ai/claude-code   # Claude Code
   npm install -g opencode-ai                 # OpenCode
   # Authenticate each agent before continuing:
   claude       # complete OAuth
   opencode     # complete auth
   gh auth login
   # Then run platform-setup to install tools and configure projects:
   # /platform-setup
   ```

### Mode 3: Project Setup

User wants to add a project to an already-running Tangerine instance. You help them add the project to Tangerine.

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

## Credentials

Tangerine does not manage agent credentials. Before starting Tangerine, ensure each agent you plan to use is already installed and authenticated:

- **Claude Code**: `claude --version` works and `claude` can make API calls (OAuth or `ANTHROPIC_API_KEY` set)
- **OpenCode**: `opencode --version` works and `opencode` can make API calls
- **Codex**: `codex --version` works and credentials are configured

Tangerine does not configure or verify credentials — it relies on the agent's own auth being in place. If an agent fails to start due to missing credentials, authenticate it directly (e.g. run `claude` once to complete OAuth, or set the relevant API key in your shell profile) and retry.

`gh` CLI is also required for GitHub integration (PR tracking, webhook setup). Tangerine checks `gh auth status` on startup and will warn if it is not authenticated — run `gh auth login` to fix it.

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
