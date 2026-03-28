---
name: platform-setup
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
    ├── ~/tangerine-workspace/project-a/0 (main clone)
    │                                   1 (task worktree)
    │                                   2 (task worktree)
    ├── ~/tangerine-workspace/project-b/0, 1, ...
    ├── agents (claude, opencode) — local processes
    └── Apache, MariaDB, tools — shared
```

No SSH tunnels, no per-project VMs. One VM, all projects.

## Setup Modes

### Mode 1: Fresh VM Setup (from host)

User runs `/platform-setup` from the HOST machine. You help them:

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

User runs `/platform-setup` from INSIDE the VM in a project directory. You help them add the project to Tangerine.

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
   - Test command
   - Post-update command (install deps + build, runs after git pull)
4. **Write config** to `~/tangerine/config.json`:
   ```json
   {
     "name": "my-project",
     "repo": "https://github.com/org/repo",
     "defaultBranch": "main",
     "setup": "pnpm install",
     "test": "pnpm test",
     "defaultProvider": "claude-code",
     "postUpdateCommand": "pnpm install && pnpm build"
   }
   ```
5. **Clone the repo** (into 0):
   ```bash
   mkdir -p ~/tangerine-workspace/my-project
   git clone <repo-url> ~/tangerine-workspace/my-project/0
   ```
### Base Setup Includes

The `deploy/base-setup.sh` installs these globally:
- git, curl, jq, tmux, unzip
- Node.js 22 LTS, npm, pnpm
- Bun runtime
- PHP CLI + common extensions, Composer
- OpenCode + Claude Code (pre-installed globally)
- gh CLI

## Agent Skills

Skills are installed by running `bin/tangerine install` inside the VM. This symlinks skill directories from `skills/` into `~/.claude/skills/`.

```bash
# Inside the VM:
bin/tangerine install
```

This installs the built-in skills (`task-handbook`, `platform-setup`). For project-specific skills, symlink them manually:

```bash
ln -s /path/to/skill ~/.claude/skills/my-skill
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
