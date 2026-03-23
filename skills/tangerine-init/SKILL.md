---
name: tangerine-init
description: Set up a project for Tangerine — analyze the codebase, generate configuration, and guide the user through building images and running the platform.
metadata:
  author: tung
  version: "0.4.0"
---

# Tangerine Init Skill

Set up a project to run on the Tangerine coding agent platform. Generates configuration, then guides the user through the full workflow.

## What You Generate

1. **Project registration** via `tangerine project add` — registers the project in `~/tangerine/config.json`
2. **`~/tangerine/images/<image-name>/build.sh`** — golden image build script (apt packages, runtimes, tools installed on top of Debian 13 base). Create via `tangerine image init <image-name>` or write directly.

## Workflow

1. **Scan the codebase** for stack indicators (see references/stacks.md)
2. **Detect**:
   - Language runtimes and versions
   - Package managers
   - Frameworks and their dev server ports
   - Database/service dependencies
   - Test runners and commands
   - Docker/container usage
   - CI config (often reveals required tooling)
3. **Read the template** before generating:
   - `~/.claude/skills/tangerine-init/templates/build.sh` for build script structure
4. **Present the plan** to the user before writing:
   - Detected stack summary
   - Proposed image name
   - What goes in `build.sh` vs setup command
   - Preview port and test command
5. **Register the project** using the CLI after user confirms:
   ```bash
   tangerine project add \
     --name <name> \
     --repo <repo-url> \
     --image <image-name> \
     --setup "<setup-command>" \
     --preview-port <port> \
     --test "<test-command>"
   ```
6. **Write `~/tangerine/images/<image-name>/build.sh`** (or run `tangerine image init <image-name>` to scaffold it)

## Key Principles

### build.sh vs setup command

- **`build.sh`** (baked into image): runtimes, system packages, global tools, browser binaries — things that are slow to install and shared across sessions
- **`setup`** (runs each session): `npm install`, `composer install`, starting dev servers — project-specific, changes with each branch

### Base Image Includes

The Debian 13 base VM already has these — do NOT add them to build.sh:
- git, curl, wget, jq, build-essential, openssh-server
- Node.js 22 (via nvm), npm
- Bun runtime
- OpenCode + Claude Code (both pre-installed globally)
- gh CLI
- ripgrep, fd-find
- Docker + Docker Compose

### Image Naming

Use descriptive kebab-case: `node-dev`, `wordpress-dev`, `python-django-dev`, `rails-dev`, `fullstack-dev`

Check if `~/tangerine/images/<image-name>/build.sh` already exists before creating a new one.

### Preview Port

- Next.js / Vite / CRA: 3000 or 5173
- WordPress (wp-env): 8888
- Rails: 3000
- Django: 8000
- Phoenix: 4000
- Look for port config in package.json scripts, docker-compose, framework config

### Extra Ports

If the project needs additional forwarded ports (database UIs, API servers, etc.), add them to config.json under `ports`.

## File Locations

- **Central config**: `~/tangerine/config.json` — managed by `tangerine project add/remove`, holds all project registrations
- **Build scripts**: `~/tangerine/images/<image-name>/build.sh` — one per image, scaffold with `tangerine image init`

```
~/tangerine/
  config.json             # all projects registered here (managed by CLI)
  tangerine.db            # task/VM database
  images/
    node-dev/
      build.sh            # golden image build script
    wordpress-dev/
      build.sh
```

## What to Ask the User

Only ask if you genuinely can't determine from the codebase:
- Which repo URL to use (if no git remote found)
- Preview port (if ambiguous — multiple possible dev servers)

## After Init: Using Tangerine

After writing the config files, guide the user through the next steps.

### Prerequisites

- **Bun** installed
- **Lima** installed (`brew install lima` on macOS)
- **tangerine** CLI available globally (`bun link` from the tangerine repo, or `npm i -g tangerine`)
- **LLM credentials**: `tangerine config set CLAUDE_CODE_OAUTH_TOKEN=...` (or `ANTHROPIC_API_KEY`, or `opencode auth login`)
- **GitHub token**: `tangerine config set GITHUB_TOKEN=ghp_...` (for PR creation and repo cloning)

### First-time Setup

```bash
# 1. Set credentials (stored in ~/tangerine/.credentials, mode 0600)
tangerine config set CLAUDE_CODE_OAUTH_TOKEN=...
tangerine config set GITHUB_TOKEN=ghp_...
# Optional: ANTHROPIC_API_KEY
# Optional for GitHub Enterprise (requires local SOCKS proxy):
# tangerine config set GH_ENTERPRISE_TOKEN=ghe_...
# tangerine config set GH_HOST=github.example.com
# tangerine config set PROXY_PORT=8080

# 2. Register the project (done by this skill via tangerine project add)
tangerine project add --name my-app --repo https://github.com/me/my-app --image node-dev --setup "npm install && npm run dev"

# 3. Scaffold and edit the build script
tangerine image init node-dev
# Edit ~/tangerine/images/node-dev/build.sh

# 4. Build the base image (one-time, ~10 min)
tangerine image build-base

# 5. Build the project golden image (clones base + runs build.sh, ~2-5 min)
tangerine image build

# 6. Start the server + web dashboard
tangerine start
```

### Day-to-day Usage

```bash
# Start tangerine (serves all registered projects)
tangerine start

# The web dashboard opens at http://localhost:3456
# - Select project from dropdown
# - View tasks (sourced from GitHub issues or created manually)
# - Click a task to open the chat UI + live preview
# - Choose agent provider: OpenCode or Claude Code
# - The agent runs in an isolated VM with full access to the project

# Manage projects
tangerine project list
tangerine project show my-app
tangerine project remove old-app

# Create tasks manually
tangerine task create --project my-app --title "Fix bug"

# Manage credentials
tangerine config list
tangerine config set CLAUDE_CODE_OAUTH_TOKEN=...
tangerine config unset GH_ENTERPRISE_TOKEN

# Rebuild the image when project dependencies change
tangerine image build
```

### How It Works

1. **Task created** (from GitHub webhook or manually via dashboard/CLI)
2. **Per-project VM** acquired (one persistent VM per project, cloned from golden image)
3. **Git worktree created** for task isolation (branch: `tangerine/<task-prefix>`)
4. **Credentials injected** (LLM API key + GitHub token via `tangerine config`)
5. **Agent starts** inside VM — OpenCode (SSE over SSH tunnel) or Claude Code (NDJSON over SSH stdin/stdout)
6. **User chats** with the agent through the web dashboard
7. **Agent works** — edits code, runs tests, creates PRs
8. **Worktree cleaned up** on completion — VM persists for the next task

### Key Concepts

- **Golden image**: a VM snapshot with your project's runtimes and tools pre-installed (built from `~/tangerine/images/<name>/build.sh`). Two-layer: base image (slow, shared) + project image (fast, project-specific). Rebuild when deps change.
- **Per-project VMs**: one persistent VM per project (not pooled). VMs survive task completion and server restarts. Tasks use git worktrees for isolation, not separate VMs.
- **Multi-provider agents**: choose OpenCode or Claude Code per task. Both pre-installed in base image. Credentials managed via `tangerine config set`. Claude Code uses `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`; OpenCode uses `auth.json` or `ANTHROPIC_API_KEY`.
- **Multi-project**: tangerine supports multiple projects from a single server. Register projects with `tangerine project add`.
- **Health monitoring**: background health checks every 30s detect dead VMs or unresponsive agents, auto-recover or fail gracefully.
- **Retry**: failed or cancelled tasks can be retried from the web dashboard — creates a fresh task with the same params.
