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
    ├── {workspace}/project-a/0 (main clone)
    │                          1 (task worktree)
    │                          2 (task worktree)
    ├── {workspace}/project-b/0, 1, ...
    ├── agents (claude, opencode) — local processes
    └── Apache, MariaDB, tools — shared
```
`{workspace}` defaults to `~/tangerine-workspace` but is configurable via `config.workspace` in `~/tangerine/config.json`.

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
   - `sshHost` — SSH hostname for editor deep-links (e.g. `"dev-vm"`)
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
- git, curl, jq, tmux, unzip
- Node.js 22 LTS, npm, pnpm
- Bun runtime
- PHP CLI + common extensions, Composer
- OpenCode + Claude Code (pre-installed globally)
- gh CLI

## Agent Skills

Skills are installed by running `bin/tangerine install` inside the VM. This symlinks skill directories into both `~/.claude/skills/` (Claude Code) and `~/.codex/skills/` (Codex).

```bash
# Inside the VM:
bin/tangerine install
```

This installs the built-in skills (`tangerine-tasks`, `platform-setup`, `browser-test`) for both Claude Code and Codex agents. For project-specific skills, symlink them manually:

```bash
ln -s /path/to/skill ~/.claude/skills/my-skill
ln -s /path/to/skill ~/.codex/skills/my-skill
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
