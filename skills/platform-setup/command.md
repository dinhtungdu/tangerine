---
description: Set up Tangerine — on host machine or in a VM, install tools, configure projects, install agent skills
---
Read SKILL.md for full instructions (`~/.claude/skills/platform-setup/SKILL.md` on Claude Code, `~/.codex/skills/platform-setup/SKILL.md` on Codex).

**Step 0 — Detect environment (run these checks in parallel):**
```bash
limactl list 2>/dev/null   # exits 0 = inside host with Lima available
uname -s                   # Darwin = macOS, Linux = Linux
which tangerine 2>/dev/null || ls ~/workspace/tangerine/bin/tangerine 2>/dev/null
cat ~/tangerine/config.json 2>/dev/null
```

Determine mode:
- **Mode 1 (host, no VM)**: on host (`limactl` works or not installed) AND user wants to run natively. Ask: "Do you want to run Tangerine directly on this machine, or inside a Lima VM?"
- **Mode 2 (host → Lima VM)**: on host and user wants a Lima VM.
- **Mode 3 (already inside VM or on host, adding a project)**: `~/tangerine/config.json` already exists OR we're in a project directory.

**Step 1 — Act based on mode:**

**Mode 1 — Host native setup**: Follow Mode 1 steps in SKILL.md. Detect OS first (`uname -s`), then install prerequisites accordingly.

**Mode 2 — Lima VM setup**: Follow Mode 2 steps in SKILL.md.

**Mode 3 — Add a project**: Read reference files first:
- `~/.claude/skills/platform-setup/references/stacks.md` (Claude Code) or `~/.codex/skills/platform-setup/references/stacks.md` (Codex)

Then follow the Project Setup Workflow in SKILL.md:
1. Get repo URL (and optional project name) from user
2. Read workspace: `jq -r '.workspace // "~/tangerine-workspace"' ~/tangerine/config.json`
3. Clone repo to `{workspace}/<project>/0`
4. Scan the cloned repo for stack
5. Present plan, get confirmation
6. Write project config to `~/tangerine/config.json`
7. If skills are not yet installed, show the manual `ln -sfn` commands from the Agent Skills section in SKILL.md — do NOT suggest `bin/tangerine install` as a bootstrap step since it presupposes skills already being present
8. Guide through `bin/tangerine start`

$ARGUMENTS
