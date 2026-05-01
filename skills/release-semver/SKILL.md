---
name: release-semver
description: Coordinate an unattended semver release: delegate version bump to a worker PR, auto-merge it, pull main, then publish.
metadata:
  author: tung
  version: "1.0.0"
---

# Release Semver

Use when user asks to release a new semantic version of a project/package.

Goal: coordinator does release orchestration only. Worker edits version files. Coordinator watches PR, merges it without human handoff, pulls `main`, publishes release.

## Preconditions

- User gave target version (`1.2.3`) or bump kind (`patch`, `minor`, `major`, `prerelease`). If missing, ask once.
- Run from project root/main clone, ideally as a `runner` task.
- `gh` authenticated with permission to merge and publish releases.
- Never use bypass flags: no `--admin`, no `--force`, no `--no-verify`.
- Only use `gh pr merge` when current user explicitly requested unattended merge/release in this task, or repo owner matches `gh api user --jq .login`.

## 1. Resolve Tangerine context

```bash
API=http://localhost:${TANGERINE_PORT:-3456}
AUTH_SESSION=$(curl -s "$API/api/auth/session")
echo "$AUTH_SESSION" | jq '{enabled, authenticated}'
AUTH_ENABLED=$(echo "$AUTH_SESSION" | jq -r '.enabled // false')
if [ "$AUTH_ENABLED" = "true" ] && [ -z "$TANGERINE_AUTH_TOKEN" ]; then
  echo "Tangerine auth enabled but TANGERINE_AUTH_TOKEN missing" >&2
  exit 1
fi

TASK_JSON=$(curl -s -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID")
PROJECT_ID=$(echo "$TASK_JSON" | jq -r '.projectId')
DEFAULT_BRANCH=$(curl -s -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/projects/$PROJECT_ID" | jq -r '.defaultBranch // "main"')
```

## 2. Compute next version

If exact version provided, use it. If bump kind provided and repo has `package.json`:

```bash
CURRENT_VERSION=$(jq -r '.version' package.json)
# Use node semver when available; otherwise compute patch/minor/major manually.
```

Before continuing:

```bash
git fetch origin "$DEFAULT_BRANCH"
git checkout "$DEFAULT_BRANCH"
git pull --ff-only origin "$DEFAULT_BRANCH"
test -z "$(git status --short)" || { git status --short; echo "Working tree dirty" >&2; exit 1; }
```

## 3. Spawn worker to bump version

Worker owns all file edits and tests. Coordinator must not edit version files.

```bash
NEXT_VERSION="<resolved-version>"
BUMP_TASK=$(curl -s -X POST "$API/api/tasks" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg projectId "$PROJECT_ID" \
    --arg parentTaskId "$TANGERINE_TASK_ID" \
    --arg version "$NEXT_VERSION" \
    '{
      projectId: $projectId,
      title: ("Bump version to v" + $version),
      type: "worker",
      source: "cross-project",
      parentTaskId: $parentTaskId,
      description: (
        "Bump repo version to v" + $version + ". " +
        "Update package/version manifests and lockfiles only. " +
        "Do not publish, tag, or create a GitHub release. " +
        "Run required checks. Create a ready-to-review PR (never draft if prMode ready). " +
        "Use branch release/v" + $version + "."
      )
    }')")
BUMP_TASK_ID=$(echo "$BUMP_TASK" | jq -r '.id')
echo "$BUMP_TASK_ID"
```

## 4. Wait for PR URL

```bash
PR_URL=""
for i in $(seq 1 60); do
  TASK=$(curl -s -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$BUMP_TASK_ID")
  STATUS=$(echo "$TASK" | jq -r '.status')
  PR_URL=$(echo "$TASK" | jq -r '.prUrl // empty')
  [ -n "$PR_URL" ] && break
  case "$STATUS" in failed|cancelled) echo "Version bump task $STATUS" >&2; exit 1;; esac
  sleep 60
done
[ -n "$PR_URL" ] || { echo "Timed out waiting for PR" >&2; exit 1; }
```

## 5. Watch checks and merge PR

Prefer auto-merge. Do not bypass branch protection.

```bash
# Queue merge if checks/branch protection require it.
gh pr merge "$PR_URL" --squash --delete-branch --auto || true

for i in $(seq 1 60); do
  STATE=$(gh pr view "$PR_URL" --json state,mergeStateStatus,isDraft --jq '{state,mergeStateStatus,isDraft}')
  echo "$STATE"
  if [ "$(echo "$STATE" | jq -r '.state')" = "MERGED" ]; then
    break
  fi
  if [ "$(echo "$STATE" | jq -r '.isDraft')" = "true" ]; then
    echo "PR is draft; cannot auto-merge" >&2
    exit 1
  fi

  CHECK_OUTPUT=$(gh pr checks "$PR_URL" --watch --interval 30 2>&1)
  CHECK_EXIT=$?
  echo "$CHECK_OUTPUT"
  if [ $CHECK_EXIT -ne 0 ] && ! echo "$CHECK_OUTPUT" | grep -qi "no checks"; then
    echo "PR checks failed" >&2
    exit 1
  fi

  gh pr merge "$PR_URL" --squash --delete-branch --auto || gh pr merge "$PR_URL" --squash --delete-branch
  sleep 60
done

[ "$(gh pr view "$PR_URL" --json state --jq .state)" = "MERGED" ] || { echo "Timed out waiting for merge" >&2; exit 1; }
```

If merge/checks fail, stop and report failing checks. Do not ask human to merge.

## 6. Pull main and verify version

```bash
git checkout "$DEFAULT_BRANCH"
git pull --ff-only origin "$DEFAULT_BRANCH"
ACTUAL_VERSION=$(jq -r '.version // empty' package.json 2>/dev/null || true)
[ -z "$ACTUAL_VERSION" ] || [ "$ACTUAL_VERSION" = "$NEXT_VERSION" ] || {
  echo "Expected $NEXT_VERSION, got $ACTUAL_VERSION" >&2
  exit 1
}
```

## 7. Publish release

Use repo release script if present. Otherwise use package fallback.

```bash
bun run check

if jq -e '.scripts.release' package.json >/dev/null 2>&1; then
  bun run release
elif [ -f package.json ]; then
  bun publish
else
  echo "No release script/package.json; publish manually per repo docs" >&2
  exit 1
fi
```

If project expects GitHub releases/tags and no release script created them:

```bash
TAG="v$NEXT_VERSION"
git fetch --tags
if ! git rev-parse "$TAG" >/dev/null 2>&1; then
  git tag -a "$TAG" -m "$TAG"
  git push origin "$TAG"
fi
if ! gh release view "$TAG" >/dev/null 2>&1; then
  gh release create "$TAG" --generate-notes
fi
```

## 8. Finish

Report:

- version
- bump task full UUID
- PR URL
- merge status
- publish command used
- tag/release URL, if created

If current task is a runner, call `/done` only after publish succeeds:

```bash
curl -X POST -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID/done"
```
