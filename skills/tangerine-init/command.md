---
description: Analyze a project and generate Tangerine configuration (.tangerine/config.json + .tangerine/build.sh)
---
Read ~/.claude/skills/tangerine-init/SKILL.md for the full skill instructions, then analyze the current project and generate Tangerine configuration.

Read the reference files before generating:
- ~/.claude/skills/tangerine-init/references/stacks.md — stack detection patterns
- ~/.claude/skills/tangerine-init/templates/config.json — config template
- ~/.claude/skills/tangerine-init/templates/build.sh — build script template

Scan the codebase, present your findings and proposed config to the user, then write the files after confirmation. $ARGUMENTS
