---
name: tangerine-init
description: Analyze a project codebase and generate Tangerine configuration (.tangerine/config.json + .tangerine/build.sh) for running coding agents in isolated VMs.
metadata:
  author: tung
  version: "0.2.0"
---

# Tangerine Init Skill

Generate golden image configuration for a project so it can run on the Tangerine coding agent platform.

## What You Generate

1. **`.tangerine/config.json`** — project config (repo, image name, setup commands, preview port, test command, env vars)
2. **`.tangerine/build.sh`** — golden image build script (apt packages, runtimes, tools installed on top of Debian 13 base)

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
3. **Read the templates** before generating:
   - `~/.claude/skills/tangerine-init/templates/config.json` for config structure
   - `~/.claude/skills/tangerine-init/templates/build.sh` for build script structure
4. **Present the plan** to the user before writing:
   - Detected stack summary
   - Proposed image name
   - What goes in `build.sh` vs what goes in `config.json` setup
   - Preview port and test command
5. **Write files** after user confirms

## Key Principles

### build.sh vs setup command

- **`build.sh`** (baked into image): runtimes, system packages, global tools, browser binaries — things that are slow to install and shared across sessions
- **`setup`** (runs each session): `npm install`, `composer install`, starting dev servers — project-specific, changes with each branch

### Base Image Includes

The Debian 13 base VM already has these — do NOT add them to build.sh:
- git, curl, wget, jq, build-essential, openssh-server
- Node.js (via nvm), npm
- OpenCode (pre-installed)
- gh CLI
- ripgrep, fd-find
- Docker + Docker Compose

### Image Naming

Use descriptive kebab-case: `node-dev`, `wordpress-dev`, `python-django-dev`, `rails-dev`, `fullstack-dev`

Check if `.tangerine/build.sh` already exists in the project before creating a new one.

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

Everything lives in `.tangerine/` at the project root:

```
my-app/
  .tangerine/
    config.json           # project config
    build.sh              # golden image build script
```

- Write `.tangerine/config.json` to the project root (cwd)
- Write `.tangerine/build.sh` to the project root (cwd)

## What to Ask the User

Only ask if you genuinely can't determine from the codebase:
- Which repo URL to use (if no git remote found)
- Preview port (if ambiguous — multiple possible dev servers)
