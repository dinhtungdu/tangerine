---
name: tangerine
description: Reference for agents running inside a Tangerine task — API endpoints, env vars, and common workflows.
metadata:
  author: tung
  version: "1.0.0"
---

# Tangerine Agent Reference

You are running inside a **Tangerine task**. Tangerine is a local coding agent platform that manages task lifecycle, worktrees, and agent processes.

## Environment

| Variable | Value |
|----------|-------|
| `TANGERINE_TASK_ID` | Your current task ID (always set) |

The Tangerine API server is always at `http://localhost:3456` (or `http://localhost:${PORT}` if `PORT` is overridden).

```bash
# Get your task ID
echo $TANGERINE_TASK_ID

# API base
API=http://localhost:3456
```

## Key API Endpoints

### Tasks

```bash
# Get your current task
curl $API/api/tasks/$TANGERINE_TASK_ID

# List all tasks
curl "$API/api/tasks"

# List by status
curl "$API/api/tasks?status=running"

# Create a new task (cross-project delegation)
curl -X POST $API/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Task title",
    "description": "What to do",
    "source": "cross-project",
    "provider": "claude-code"
  }'

# Mark your task as done
curl -X POST $API/api/tasks/$TANGERINE_TASK_ID/done

# Cancel a task
curl -X POST $API/api/tasks/<id>/cancel
```

### Session / Chat

```bash
# Get all messages for your session
curl $API/api/tasks/$TANGERINE_TASK_ID/messages

# Get activity log
curl $API/api/tasks/$TANGERINE_TASK_ID/activities

# Get git diff (all changes vs default branch)
curl $API/api/tasks/$TANGERINE_TASK_ID/diff
```

### Projects

```bash
# List all configured projects
curl $API/api/projects

# Get a specific project
curl $API/api/projects/<project-name>
```

## Common Workflows

### Delegate to another agent

Create a sub-task and let another agent handle it:

```bash
curl -X POST http://localhost:3456/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "other-project",
    "title": "Fix the login bug",
    "description": "The login form throws a 500 when email contains a +. Fix it.",
    "source": "cross-project",
    "provider": "claude-code"
  }'
```

### Mark your task done

When you've completed your work and pushed a branch/PR, signal completion:

```bash
curl -X POST http://localhost:3456/api/tasks/$TANGERINE_TASK_ID/done
```

### Check your worktree and branch

Your task's worktree path and branch are in the task record:

```bash
curl http://localhost:3456/api/tasks/$TANGERINE_TASK_ID | jq '{branch, worktreePath, status}'
```

## Task Object Shape

```json
{
  "id": "abc123",
  "projectId": "my-project",
  "title": "Fix the login bug",
  "description": "...",
  "status": "running",
  "provider": "claude-code",
  "branch": "task/fix-login-bug-abc123",
  "worktreePath": "/workspace/my-project/repo/worktrees/abc123",
  "prUrl": null,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

## Task Statuses

| Status | Meaning |
|--------|---------|
| `created` | Queued, not started |
| `provisioning` | Worktree being set up |
| `running` | Agent actively working |
| `done` | Completed successfully |
| `failed` | Errored out |
| `cancelled` | Cancelled by user or system |
