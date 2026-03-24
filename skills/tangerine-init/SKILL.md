---
name: tangerine-init
description: Set up Tangerine inside a VM — install tools, configure projects, clone repos, and install agent skills.
metadata:
  author: tung
  version: "1.0.0"
---

# Tangerine Init Skill

Set up the Tangerine coding agent platform. Tangerine runs INSIDE a VM (or VPS) — the server, dashboard, agents, and all project repos live together on one machine. The VM is a sandbox where agents run with `--dangerously-skip-permissions`.

## Architecture (v1)

```
Host (laptop)
│  browser → localhost:3456
└── VM (Lima)
    ├── tangerine server + dashboard (:3456)
    ├── /workspace/project-a/repo (worktrees per task)
    ├── /workspace/project-b/repo
    ├── agents (claude, opencode) — local processes
    └── Apache, MariaDB, tools — shared
```

No SSH tunnels, no per-project VMs. One VM, all projects.

## Setup Modes

### Mode 1: Fresh VM Setup (from host)

User runs `/tangerine-init` from the HOST machine. You help them:

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

### Mode 2: Project Setup (inside VM)

User runs `/tangerine-init` from INSIDE the VM in a project directory. You help them add the project to Tangerine.

## Project Setup Workflow

1. **Scan the codebase** for stack indicators (see references/stacks.md)
2. **Detect**:
   - Language runtimes and versions
   - Package managers
   - Frameworks and dev server configuration
   - Database/service dependencies
   - Test runners and commands
   - CI config (reveals required tooling)
3. **Present the plan** before writing:
   - Detected stack summary
   - Proposed project name
   - Setup command (runs per-task in worktree)
   - Preview config (if WordPress or dev server)
   - Test command
4. **Write config** to `~/tangerine/config.json`:
   ```json
   {
     "name": "my-project",
     "repo": "https://github.com/org/repo",
     "defaultBranch": "main",
     "setup": "pnpm install",
     "test": "pnpm test",
     "preview": {
       "baseUrl": "http://woo-next.test",
       "provision": "$HOME/worktree-scripts/provision.sh",
       "teardown": "$HOME/worktree-scripts/teardown.sh"
     },
     "defaultProvider": "claude-code"
   }
   ```
5. **Clone the repo**:
   ```bash
   mkdir -p /workspace/my-project
   git clone <repo-url> /workspace/my-project/repo
   ```
6. **Write build.sh** if project needs extra tools (optional):
   - `~/tangerine/images/<project-name>/build.sh`
   - Only for project-specific system packages (Apache, MariaDB, PHP extensions, etc.)
   - Most projects don't need this — base setup covers common tools

### setup vs build.sh

- **`setup`** (runs per-task in worktree): `pnpm install`, `composer install` — fast, dependency-level
- **`build.sh`** (runs once during VM provisioning): system packages, services — slow, machine-level

### Base Setup Includes

The `deploy/base-setup.sh` installs these — do NOT add them to build.sh:
- git, curl, jq, tmux, unzip
- Node.js 22 LTS, npm, pnpm
- Bun runtime
- PHP CLI + common extensions, Composer
- OpenCode + Claude Code (pre-installed globally)
- gh CLI

### Preview Config

**WordPress (subdirectory sites)**:
```json
"preview": {
  "baseUrl": "http://woo-next.test",
  "provision": "$HOME/worktree-scripts/provision.sh",
  "teardown": "$HOME/worktree-scripts/teardown.sh"
}
```
Each task gets a subdirectory: `http://woo-next.test/{task-slug}/`

**Dev server (Node/React/etc.)**:
No preview config needed — or provide a `command`:
```json
"preview": {
  "baseUrl": "http://localhost",
  "command": "npm run dev -- --port $PORT"
}
```

## Agent Skills

Install skills that agents inside the VM will use. These go in the VM's `~/.claude/skills/` directory.

After setting up projects, ask the user which skills to install:

```bash
# Inside the VM:
claude skill install <skill-name>
# Or copy skill directories to ~/.claude/skills/
```

Common skills for agents:
- Project-specific CLAUDE.md (copied from repo)
- Code review skills
- Testing skills

## Credentials

Credentials are set up ONCE in the VM environment, not managed per-task:

```bash
# Git credentials (for repo cloning)
git config --global credential.helper store
echo "https://x-access-token:$TOKEN@github.com" > ~/.git-credentials
chmod 600 ~/.git-credentials

# For GitHub Enterprise (with SOCKS proxy from host):
git config --global http.https://github.example.com/.proxy socks5://127.0.0.2:8080
git config --global url."https://github.example.com/".insteadOf "git@github.example.com:"

# LLM API keys (in ~/.env or shell profile)
export ANTHROPIC_API_KEY=sk-ant-...
# Or for Claude Code OAuth:
export CLAUDE_CODE_OAUTH_TOKEN=...

# gh CLI auth
gh auth login
```

## GHE (GitHub Enterprise) Access

For repos on `github.example.com` behind a SOCKS proxy:

1. **On the host**, the SOCKS proxy runs (e.g., AutoProxxy on port 8080)
2. **Set up a persistent reverse tunnel** from host into VM:
   ```bash
   # On host (add to SSH config or run manually):
   ssh -fN -R 127.0.0.2:8080:127.0.0.1:8080 <vm-user>@<vm-ip>
   ```
3. **Inside VM**, configure git:
   ```bash
   git config --global http.https://github.example.com/.proxy socks5://127.0.0.2:8080
   git config --global url."https://github.example.com/".insteadOf "git@github.example.com:"
   export HTTPS_PROXY=socks5://127.0.0.2:8080
   export GH_HOST=github.example.com
   ```

## File Locations

```
~/tangerine/
  config.json             # all projects (managed by tangerine CLI)
  tangerine.db            # task database
  images/
    ciab-dev/
      build.sh            # project-specific system setup (optional)
      provision.sh        # preview provisioning script
      wordpress/           # seed data

/workspace/
  project-a/
    repo/                 # git clone
      worktrees/          # per-task worktrees
  project-b/
    repo/

~/workspace/tangerine/    # tangerine source code
  deploy/
    tangerine.yaml        # Lima VM template
    base-setup.sh         # common tool installation
```

## What to Ask the User

Only ask if you can't determine from the codebase:
- Repo URL (if no git remote found)
- Whether it's a GHE repo (needs proxy setup)
- Preview type (WordPress subdirectory vs dev server)
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
