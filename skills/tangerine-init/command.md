---
description: Set up Tangerine — create VM, install tools, configure projects, install agent skills
---
Read ~/.claude/skills/tangerine-init/SKILL.md for full instructions.

**Step 0 — Detect environment:**
- Are we on the HOST or INSIDE the VM? Check: `limactl list 2>/dev/null` works = host. `/workspace` exists = inside VM.
- If on host: guide through VM creation + base setup (Mode 1)
- If inside VM: guide through project setup (Mode 2)

**Step 1 — Check existing setup:**
- Check if `~/tangerine/config.json` exists. If yes, show registered projects and ask what the user wants to do.
- Check if we're in a project directory with a git repo.

**If setting up a new project:**

Read the reference files before generating:
- ~/.claude/skills/tangerine-init/references/stacks.md — stack detection patterns

Scan the codebase, present findings, then after confirmation:
1. Write project config to `~/tangerine/config.json`
2. Clone repo to `/workspace/<project>/repo` (if not already cloned)
3. Write `~/tangerine/images/<name>/build.sh` if project needs extra system packages
4. Ask about preview setup (WordPress subdirectory or dev server)
5. Ask about agent skills to install in `~/.claude/skills/`
6. Guide through `bin/tangerine start`

$ARGUMENTS
