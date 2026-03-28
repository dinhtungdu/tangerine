---
description: Set up Tangerine — create VM, install tools, configure projects, install agent skills
---
Read ~/.claude/skills/platform-setup/SKILL.md for full instructions.

**Step 0 — Detect environment:**
- Are we on the HOST or INSIDE the VM? Check: `limactl list 2>/dev/null` works = host.
- If on host: guide through VM creation + base setup (Mode 1)
- If inside VM: guide through project setup (Mode 2)

**Step 1 — Check existing setup:**
- Check if `~/tangerine/config.json` exists. If yes, show registered projects and ask what the user wants to do.
- Check if we're in a project directory with a git repo.

**If setting up a new project:**

Read the reference files before generating:
- ~/.claude/skills/platform-setup/references/stacks.md — stack detection patterns

Scan the codebase, present findings, then after confirmation:
1. Write project config to `~/tangerine/config.json`
2. Clone repo to `{workspace}/<project>/0` (if not already cloned)
3. Ask about agent skills to install in `~/.claude/skills/`
5. Guide through `bin/tangerine start`

$ARGUMENTS
