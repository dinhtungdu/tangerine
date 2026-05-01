---
description: Release a semver version by spawning a bump worker, auto-merging its PR, pulling main, then publishing
---
Read sibling `SKILL.md` for full workflow.

Input must include target version (`1.2.3`) or bump kind (`patch`, `minor`, `major`, `prerelease`). If absent, ask once.

Core flow:
1. Resolve `$TANGERINE_TASK_ID`, API base, auth, project, default branch.
2. Pull latest default branch; require clean tree.
3. Spawn worker task to bump version files/lockfiles and create ready PR.
4. Poll worker until PR URL exists.
5. Queue/perform PR merge with `gh pr merge --auto --squash --delete-branch`; never use `--admin`.
6. Pull default branch after merge.
7. Verify version.
8. Run repo release script, else `bun run check && bun publish`.
9. Create tag/GitHub release only if repo release process did not.
10. Report version, worker task UUID, PR URL, publish command, release URL.

$ARGUMENTS
