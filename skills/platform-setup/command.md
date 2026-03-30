---
description: Set up Tangerine — create VM, install tools, configure projects, install agent skills
---
Read SKILL.md for full instructions (`~/.claude/skills/platform-setup/SKILL.md` on Claude Code, `~/.codex/skills/platform-setup/SKILL.md` on Codex).

**Step 0 — Detect environment:**
- Are we on the HOST or INSIDE the VM? Check: `limactl list 2>/dev/null` works = host.
- If on host: guide through VM creation + base setup (Mode 1)
- If inside VM: guide through project setup (Mode 2)

**Step 1 — Check existing setup:**
- Check if `~/tangerine/config.json` exists. If yes, show registered projects and ask what the user wants to do.
- Check if we're in a project directory with a git repo.

**If setting up a new project:**

Read the reference files before generating:
- `~/.claude/skills/platform-setup/references/stacks.md` (Claude Code) or `~/.codex/skills/platform-setup/references/stacks.md` (Codex) — stack detection patterns

Follow the Project Setup Workflow in SKILL.md:
1. Get repo URL (and optional project name) from user
2. Read workspace: `jq -r '.workspace // "~/tangerine-workspace"' ~/tangerine/config.json`
3. Clone repo to `{workspace}/<project>/0`
4. Scan the cloned repo for stack
5. Present plan, get confirmation
6. Write project config to `~/tangerine/config.json`
7. Ask about agent skills to install (run `bin/tangerine install` — symlinks into both `~/.claude/skills/` and `~/.codex/skills/`)
8. Guide through `bin/tangerine start`

$ARGUMENTS
