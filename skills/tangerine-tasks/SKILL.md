---
name: tangerine-tasks
description: Reference for agents running inside a Tangerine task — API endpoints, env vars, and common workflows.
metadata:
  author: tung
  version: "1.8.0"
---

# Tangerine Agent Reference

> 🚨 **CRITICAL — READ FIRST (applies to ALL task types: orchestrator, worker, reviewer):**
> **`gh pr review`, `gh pr comment`, `gh pr merge`** — follow these rules strictly:
> - **Personal repos** (repo owner matches `gh api user --jq .login`): allowed when needed
> - **All other repos**: NEVER, unless the user has **explicitly asked** you to do so in this task
>
> **NEVER use bypass flags** — these skip branch protections and CI:
> - `--admin` — bypasses all branch protection rules
> - `--force` on git push — overwrites remote history
> - `--no-verify` — skips pre-push/pre-commit hooks
>
> If CI is pending, use `gh pr merge --auto --squash` to queue the merge for when checks pass. Do NOT bypass CI with `--admin`.
>
> This applies regardless of task type — orchestrators, workers, and reviewers must all follow these rules.

You are running inside a **Tangerine task**. Tangerine manages local agent processes, git worktrees, task lifecycle, and a web/API control plane.

## Environment

| Variable | Meaning |
|----------|---------|
| `TANGERINE_TASK_ID` | Current task ID |
| `TANGERINE_AUTH_TOKEN` | Auth token for the Tangerine API (may be empty when auth is disabled) |

API base:

```bash
API=http://localhost:3456
echo "$TANGERINE_TASK_ID"
```

Always include `-H "Authorization: Bearer $TANGERINE_AUTH_TOKEN"` on every Tangerine API curl call. When auth is disabled the server ignores this header; when enabled the token is always set in your environment.

> ⚠️ **Do NOT use the `${TANGERINE_AUTH_TOKEN:+-H "..."}` conditional pattern** — it breaks in OpenCode's shell context where each command runs in a fresh `zsh -lc` invocation. Use the inline form on every curl call instead.

## 🚨 PR Mode — CRITICAL (Worker Tasks)

> **You MUST check `prMode` before creating any PR. Injected into your system prompt — follow it exactly.**

```bash
PROJECT_NAME=$(curl -s -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID" | jq -r '.projectId')
PR_MODE=$(curl -s -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/projects/$PROJECT_NAME" | jq -r '.prMode // "none"')
```

Act strictly according to `PR_MODE` — no exceptions:

**`"ready"`** — normal ready-to-review PR:
```bash
gh pr create --title "..." --body "..."
```

**`"draft"`** — MUST use `--draft`:
```bash
gh pr create --draft --title "..." --body "..."
```

**`"none"`** — do NOT push or create a PR, just commit and stop:
```bash
# nothing — commit your work and stop here
```

## Common API Calls

### Tasks

```bash
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks"
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks?status=running&project=my-project"
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID"
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID/children"
curl -X POST -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID/cancel"
curl -X POST -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID/retry"
curl -X POST -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID/start"
curl -X POST -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID/seen"
curl -X POST -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID/done"
```

> **IMPORTANT — when to call `/done`:**
> - **Orchestrators**: call `/done` on yourself when ending the session.
> - **Workers**: Do NOT call `/done` proactively after PR creation. The agent auto-suspends. When the PR is merged, Tangerine re-prompts you with post-merge instructions — call `/done` then (or `/cancel` if the PR was closed without merging).
> - **Reviewers**: post the review summary in this task. Do NOT call `/done` unless post-merge/closure instructions say so.

Create a worker task:

```bash
curl -X POST "$API/api/tasks" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Fix flaky timeout in retry loop",
    "type": "worker",
    "description": "The retry loop uses a fixed 5s timeout...",
    "provider": "acp",
    "parentTaskId": "abc123",
    "source": "cross-project"
  }'
```

Create a reviewer task:

```bash
curl -X POST "$API/api/tasks" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Review PR #123",
    "type": "reviewer",
    "description": "Check for regressions",
    "provider": "acp",
    "branch": "tangerine/abc12345",
    "prUrl": "https://github.com/org/repo/pull/123",
    "parentTaskId": "abc123",
    "source": "cross-project"
  }'
```

> **Reviewer task requirements**:
> - Set `branch` to the **PR's source branch** (e.g. `tangerine/abc12345`), NOT the PR number shorthand (`#123`) or a new branch. The reviewer must check out the same branch as the PR.
> - Always set `prUrl` to the full PR URL (e.g. `https://github.com/org/repo/pull/123`). The poller can discover it from the branch as a fallback, but setting it upfront ensures immediate tracking.

Provider values are configured ACP agent IDs from `agents[]` (default: `acp`). Omit `provider` to use project/global `defaultAgent`. Put durable custom instructions in `taskTypes.<type>.systemPrompt`, not provider names, task titles, or one-off prompts.

Task types — **always pass the correct type**:

- `worker` — default for implementation (features, fixes, refactors). Gets a worktree, branch, and PR tracking.
- `reviewer` — **MUST use for any code review task** (reviewing a PR, auditing a diff, checking for regressions). Never use `worker` for review work — reviewer tasks get review-specific capabilities and UI treatment.
- `runner` — no worktree allocation, runs on project root, no PR tracking, agent self-completes. Use for publish, deploy, or any non-code-change task.
- `orchestrator` — system-managed, do not create manually

Example runner task (no worktree, no PR):

```bash
curl -X POST "$API/api/tasks" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Publish v1.0.0 to npm",
    "type": "runner",
    "description": "Run bun publish after verifying build passes",
    "source": "cross-project",
    "parentTaskId": "abc123"
  }'
```

## Task-Type Custom System Prompts

Projects can define custom system prompts per task type. Use these for persistent custom instructions such as review focus, coding standards, orchestration policy, or reporting style.

Supported task types: `worker`, `orchestrator`, `reviewer`.

```json
{
  "projects": [{
    "name": "my-project",
    "repo": "org/repo",
    "setup": "bun install",
    "taskTypes": {
      "worker": {
        "systemPrompt": "Follow the project coding standards. Keep changes small."
      },
      "reviewer": {
        "systemPrompt": "Review for regressions, security issues, and missing tests."
      },
      "orchestrator": {
        "systemPrompt": "Keep tasks small. Send unrelated issues to triage."
      }
    }
  }]
}
```

Operational Tangerine notes still apply: auth, PR mode, branch workflow, and orchestrator delegation rules. A custom prompt replaces default user-layer notes such as terse style and setup-status reminder; include those explicitly if wanted.

### Session / Chat

```bash
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID/messages"
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID/activities"
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID/diff"

curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/prompt" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Continue from the latest failing test."}'

curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/chat" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Summarize what changed."}'

curl -X POST -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID/abort"

curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/model" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5","reasoningEffort":"high","mode":"code"}'

curl -X PATCH "$API/api/tasks/$TANGERINE_TASK_ID" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prUrl":"https://github.com/org/repo/pull/123"}'
```

### Projects

```bash
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/projects"
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/projects/my-project"

curl -X POST "$API/api/projects/my-project/orchestrator" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"acp"}'

curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/projects/my-project/update-status"
curl -X POST -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/projects/my-project/update"
```

### Crons

> **IMPORTANT:** Never use Claude Code's built-in `CronCreate` tool — it is session-only and invisible to Tangerine. Always use the Tangerine cron API below.

```bash
# List crons
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/crons"
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/crons?project=my-project"

# Create a cron (cron expression is always UTC)
curl -X POST "$API/api/crons" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Daily PR check",
    "description": "The prompt that the spawned task will execute.",
    "cron": "0 3 * * 1-5",
    "enabled": true,
    "taskDefaults": {
      "provider": "acp"
    }
  }'

# Update a cron
curl -X PATCH "$API/api/crons/<id>" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# Delete a cron
curl -X DELETE -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/crons/<id>"
```

The `description` field becomes the **prompt** given to the spawned task — write it as a clear, self-contained instruction the agent can execute without extra context.

When converting user-specified local times to UTC cron expressions, always confirm the conversion (e.g. "10am Vietnam = 3am UTC → `0 3 * * 1-5`").

### System

```bash
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/health"
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/logs?project=my-project&limit=100"
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/cleanup/orphans"
curl -X POST -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/cleanup/orphans"
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/config"
```

## Useful Workflows

### Prompt another task

```bash
curl -X POST "$API/api/tasks/<target-task-id>/prompt" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Discovered a failing edge case. Please investigate.","fromTaskId":"'"$TANGERINE_TASK_ID"'"}'
```

> ⚠️ **Orchestrators: do NOT use `/prompt` to add new requirements to a running worker.** `/prompt` is only for unblocking or clarifying the worker's existing scope. New requirements = create a new task.

### Inspect your task metadata

```bash
curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID" | jq '{id, type, status, provider, branch, worktreePath, parentTaskId, capabilities}'
```

### Read parent task context

```bash
PARENT=$(curl -s -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TANGERINE_TASK_ID" | jq -r '.parentTaskId')
test "$PARENT" != "null" && curl -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$PARENT/messages"
```

## Polling for Async Events

Use polling to wait for review task results, CI completion, child task results, or external API responses. Tangerine has no push mechanism to agents — polling is the primary pattern.

### Which fields to poll

| Goal | Endpoint | Field to watch |
|------|----------|---------------|
| Task status | `GET /api/tasks/<id>` | `.status` → `done` / `failed` / `cancelled` |
| Child tasks done | `GET /api/tasks/<id>/children` | all `.status` → `done` |
| PR CI status | `gh pr checks <pr-url>` | exit code 0 = all pass |

> **PR merges — do NOT poll for these.** When a PR is merged, Tangerine sends you a re-prompt automatically (`pr-monitor.ts` keeps your task `running` and injects a post-merge message). You will receive the prompt; you don't need to poll. Only non-running tasks get auto-completed to `done` by the monitor.

### ACP-agent shell loop

Works from any ACP agent session:

```bash
# Poll until task done (max 30 attempts, 60s interval = 30 min max)
TASK_ID="<target-task-id>"
ATTEMPTS=0
MAX=30
INTERVAL=60

while [ $ATTEMPTS -lt $MAX ]; do
  STATUS=$(curl -s -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TASK_ID" | jq -r '.status')
  echo "[$ATTEMPTS] status=$STATUS"
  case "$STATUS" in
    done)      echo "Task complete."; break ;;
    failed)    echo "Task failed."; exit 1 ;;
    cancelled) echo "Task cancelled."; exit 1 ;;
  esac
  ATTEMPTS=$((ATTEMPTS + 1))
  sleep $INTERVAL
done

# Fail explicitly on timeout — do not silently continue
if [ $ATTEMPTS -ge $MAX ]; then
  echo "Timed out after $((MAX * INTERVAL))s waiting for task $TASK_ID"; exit 1
fi
```

### General-purpose wait (any reason)

Use this when you need to pause for a duration regardless of what you're waiting for — no specific endpoint to poll, just "wait N seconds then continue".

```bash
echo "Waiting 300s..."; sleep 300; echo "Resuming."
```

Resume the same task after wake with the polling loop above. Use `270s` for CI checks and `1200s` for review task waits.

### Recommended intervals

| Scenario | Interval | Max wait |
|----------|----------|---------|
| CI checks (fast repo) | 60s | 15–20 min |
| CI checks (slow repo) | 270s | 60 min |
| Review task result | 120s | 30 min |
| External API / long job | 300s | hours |
| Child task completion | 60–120s | task-dependent |

### Exponential backoff for flaky endpoints

```bash
DELAY=30
STATUS=""
for i in 1 2 3 4 5; do
  RESULT=$(curl -s -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" "$API/api/tasks/$TASK_ID")
  STATUS=$(echo "$RESULT" | jq -r '.status')
  case "$STATUS" in
    done)      break ;;
    failed)    echo "Task failed."; exit 1 ;;
    cancelled) echo "Task cancelled."; exit 1 ;;
  esac
  sleep $DELAY
  DELAY=$((DELAY * 2))  # 30 → 60 → 120 → 240 → 480
done
if [ "$STATUS" != "done" ]; then echo "Timed out."; exit 1; fi
```

Use backoff when hitting external APIs or GitHub (rate-limited) rather than flat intervals.

### Polling vs webhooks

**Poll** (always available):
- Waiting for a Tangerine task to finish
- Checking PR/CI status via `gh pr checks`
- Any scenario where you need a result before proceeding

**Webhooks** (Tangerine handles these automatically — you do not need to poll):
- PR merged → Tangerine re-prompts the PR-tracked task automatically
- Post-merge re-prompt → call `/done` when finished

In practice: agents always poll. Tangerine's webhook integration handles GitHub events and triggers re-prompts — agents just respond to those re-prompts rather than polling for merge events themselves.

## PR Mode

> See **🚨 PR Mode — CRITICAL** section at the top of this document.

### PR Template

Before running `gh pr create`, check for a PR template:

```bash
cat .github/pull_request_template.md 2>/dev/null || cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null
```

**If a PR template exists in the repo, you MUST use it as the structure for your PR body. Follow it strictly — do not skip sections, do not add sections not in the template.**

### Rename branch before PR

Before creating a PR, rename your branch to something descriptive. Then push with `git push -u origin HEAD`.

```bash
curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/rename-branch" \
  -H "Authorization: Bearer $TANGERINE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"branch\": \"fix/<descriptive-slug>\"}"
```

Choose a short slug that describes the change (e.g. `fix/worktree-cleanup`, `feat/add-retry-logic`). Only alphanumeric, dash, underscore, dot, and slash are allowed.

## Required: Self Review

Worker and reviewer tasks must inspect their own diff before finalizing.

### Worker tasks — self-review before PR

1. Review `git diff` against the base branch.
2. Fix every issue found.
3. Share the review result.
4. Only then run `git push origin HEAD` and create PR according to project `prMode` (see above).

### Reviewer tasks — review the PR changes

1. Review the PR diff against the base branch.
2. Include findings in the review report.
3. **Post the full review summary as your final message in this task** — verdict, key findings, any bugs found. This is what the user sees when they open the reviewer task.

> 🚨 **CRITICAL**: The review summary MUST be posted in **this task's own conversation** — do NOT skip this.

## Reporting

When reporting task IDs to the user, always print the full UUID (e.g. d3371cea-afd4-4172-90aa-e6e2b9de9bfc) — no backticks, no quotes, no truncation.

## Task Shape

Typical task fields exposed by the API:

```json
{
  "id": "abc123",
  "projectId": "my-project",
  "type": "worker",
  "source": "manual",
  "title": "Fix the failing test",
  "status": "running",
  "provider": "acp",
  "model": "gpt-5",
  "reasoningEffort": "high",
  "branch": "tangerine/abc12345",
  "worktreePath": "/workspace/my-project/1",
  "parentTaskId": null,
  "capabilities": ["resolve", "predefined-prompts", "diff", "continue"]
}
```
