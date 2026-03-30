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

Create a task:

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
    "branch": "#123",
    "parentTaskId": "abc123",
    "source": "cross-project"
  }'
```

Provider values:

- `opencode`
- `claude-code`
- `codex`

Task types:

- `worker`
- `orchestrator`
- `reviewer`

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
  -d '{"provider":"claude-code","model":"anthropic/claude-sonnet-4-6"}'

curl "$API/api/projects/my-project/update-status"
curl -X POST "$API/api/projects/my-project/update"
```

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

## Required Before PR

Run self-review before creating the PR:

```bash
codex review --base main -c model="gpt-5.4" -c reasoning.effort="xhigh"
```

Then:

1. Read the findings
2. Fix every issue found
3. Share the review result
4. Only then run `git push origin HEAD` and `gh pr create`

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
