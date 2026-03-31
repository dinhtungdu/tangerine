---
name: tangerine-tasks
description: Reference for agents running inside a Tangerine task — API endpoints, env vars, and common workflows.
metadata:
  author: tung
  version: "1.3.0"
---

# Tangerine Agent Reference

You are running inside a **Tangerine task**. Tangerine manages local agent processes, git worktrees, task lifecycle, and a web/API control plane.

## Environment

| Variable | Meaning |
|----------|---------|
| `TANGERINE_TASK_ID` | Current task ID |

API base:

```bash
API=http://localhost:3456
echo "$TANGERINE_TASK_ID"
```

## Common API Calls

### Tasks

```bash
curl "$API/api/tasks"
curl "$API/api/tasks?status=running&project=my-project"
curl "$API/api/tasks/$TANGERINE_TASK_ID"
curl "$API/api/tasks/$TANGERINE_TASK_ID/children"
curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/cancel"
curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/retry"
curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/start"
curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/seen"
curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/done"
```

> **IMPORTANT — when to call `/done`:**
> - **Orchestrators only**: call `/done` on yourself when ending the session.
> - **Workers and reviewers**: NEVER call `/done` on yourself. After pushing a PR, your job is finished — just stop. The orchestrator marks tasks done after the PR is merged.

Create a worker task:

```bash
curl -X POST "$API/api/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Fix flaky timeout in retry loop",
    "type": "worker",
    "description": "The retry loop uses a fixed 5s timeout...",
    "provider": "claude-code",
    "model": "claude-sonnet-4-6",
    "parentTaskId": "abc123",
    "source": "cross-project"
  }'
```

Create a reviewer task:

```bash
curl -X POST "$API/api/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Review PR #123",
    "type": "reviewer",
    "description": "Check for regressions",
    "provider": "codex",
    "model": "openai/gpt-5.4",
    "reasoningEffort": "high",
    "branch": "tangerine/abc12345",
    "parentTaskId": "abc123",
    "source": "cross-project"
  }'
```

> **Reviewer branch requirement**: Set `branch` to the **PR's source branch** (e.g. `tangerine/abc12345`), NOT the PR number shorthand (`#123`) or a new branch. The reviewer must check out the same branch as the PR. The PR detector and clean poller match tasks to PRs by comparing the task branch to the PR's head branch — a wrong value breaks that association.

Provider values:

- `opencode`
- `claude-code`
- `codex`

Task types — **always pass the correct type**:

- `worker` — default for implementation (features, fixes, refactors)
- `reviewer` — **MUST use for any code review task** (reviewing a PR, auditing a diff, checking for regressions). Never use `worker` for review work — reviewer tasks get review-specific capabilities and UI treatment.
- `orchestrator` — system-managed, do not create manually

### Session / Chat

```bash
curl "$API/api/tasks/$TANGERINE_TASK_ID/messages"
curl "$API/api/tasks/$TANGERINE_TASK_ID/activities"
curl "$API/api/tasks/$TANGERINE_TASK_ID/diff"

curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/prompt" \
  -H "Content-Type: application/json" \
  -d '{"text":"Continue from the latest failing test."}'

curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/chat" \
  -H "Content-Type: application/json" \
  -d '{"text":"Summarize what changed."}'

curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/abort"

curl -X POST "$API/api/tasks/$TANGERINE_TASK_ID/model" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-5.4","reasoningEffort":"high"}'

curl -X PATCH "$API/api/tasks/$TANGERINE_TASK_ID" \
  -H "Content-Type: application/json" \
  -d '{"prUrl":"https://github.com/org/repo/pull/123"}'
```

### Projects

```bash
curl "$API/api/projects"
curl "$API/api/projects/my-project"

curl -X POST "$API/api/projects/my-project/orchestrator" \
  -H "Content-Type: application/json" \
  -d '{"provider":"claude-code","model":"claude-sonnet-4-6"}'

curl "$API/api/projects/my-project/update-status"
curl -X POST "$API/api/projects/my-project/update"
```

### Crons

> **IMPORTANT:** Never use Claude Code's built-in `CronCreate` tool — it is session-only and invisible to Tangerine. Always use the Tangerine cron API below.

```bash
# List crons
curl "$API/api/crons"
curl "$API/api/crons?project=my-project"

# Create a cron (cron expression is always UTC)
curl -X POST "$API/api/crons" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Daily PR check",
    "description": "The prompt that the spawned task will execute.",
    "cron": "0 3 * * 1-5",
    "enabled": true,
    "taskDefaults": {
      "provider": "claude-code",
      "model": "claude-sonnet-4-6"
    }
  }'

# Update a cron
curl -X PATCH "$API/api/crons/<id>" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# Delete a cron
curl -X DELETE "$API/api/crons/<id>"
```

When converting user-specified local times to UTC cron expressions, always confirm the conversion (e.g. "10am Vietnam = 3am UTC → `0 3 * * 1-5`").

### System

```bash
curl "$API/api/health"
curl "$API/api/logs?project=my-project&limit=100"
curl "$API/api/cleanup/orphans"
curl -X POST "$API/api/cleanup/orphans"
curl "$API/api/config"
```

## Useful Workflows

### Prompt another task

```bash
curl -X POST "$API/api/tasks/<target-task-id>/prompt" \
  -H "Content-Type: application/json" \
  -d '{"text":"Discovered a failing edge case. Please investigate."}'
```

### Inspect your task metadata

```bash
curl "$API/api/tasks/$TANGERINE_TASK_ID" | jq '{id, type, status, provider, branch, worktreePath, parentTaskId, capabilities}'
```

### Read parent task context

```bash
PARENT=$(curl -s "$API/api/tasks/$TANGERINE_TASK_ID" | jq -r '.parentTaskId')
test "$PARENT" != "null" && curl "$API/api/tasks/$PARENT/messages"
```

## Required: Codex Review

All worker and reviewer tasks must run `codex review` — but for different purposes.

### Worker tasks — self-review before PR

Run before pushing or creating a PR:

```bash
codex review --base main -c model="gpt-5.4" -c reasoning.effort="xhigh"
```

1. Read the findings
2. Fix every issue found
3. Share the review result
4. Only then run `git push origin HEAD` and `gh pr create`

### Reviewer tasks — review the PR changes

Run as part of the review:

```bash
codex review --base main -c model="gpt-5.4" -c reasoning.effort="xhigh"
```

1. Read the findings
2. Include them in the review report
3. Report back to the parent task with a summary of issues found

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
  "provider": "codex",
  "model": "openai/gpt-5.4",
  "reasoningEffort": "high",
  "branch": "tangerine/abc12345",
  "worktreePath": "/workspace/my-project/1",
  "parentTaskId": null,
  "capabilities": ["resolve", "predefined-prompts", "diff", "continue"]
}
```
