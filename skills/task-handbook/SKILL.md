---
name: task-handbook
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

# Create a task from an existing branch
curl -X POST $API/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Continue work on feature",
    "description": "Pick up where we left off",
    "branch": "feature/my-branch"
  }'

# Create a task from a PR (resolves to the PR's head branch)
curl -X POST $API/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Review and fix PR feedback",
    "branch": "#123"
  }'

# Create a review task for a PR
curl -X POST $API/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Review PR #123",
    "description": "Review PR #123: focus on error handling",
    "type": "review",
    "branch": "#123"
  }'

# Create a review task for another task (parent-child relationship)
curl -X POST $API/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Review task abc123",
    "description": "Review task abc123: check test coverage",
    "type": "review",
    "parentTaskId": "abc123"
  }'

# Cancel a task
curl -X POST $API/api/tasks/<id>/cancel
```

### Session / Chat

```bash
# Get all messages for your session
curl $API/api/tasks/$TANGERINE_TASK_ID/messages

# Send a prompt to another task (inter-task messaging)
curl -X POST $API/api/tasks/<target-task-id>/prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "Your message here"}'

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

### Request a review of your work

Create a review task that targets your current task. The review agent will analyze your code and send findings back to you via the Tangerine API:

```bash
curl -X POST http://localhost:3456/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Review my changes",
    "description": "Review task '$TANGERINE_TASK_ID': check for edge cases",
    "type": "review",
    "parentTaskId": "'$TANGERINE_TASK_ID'"
  }'
```

When the review task starts, you'll receive a notification with its task ID. After addressing the feedback, request a follow-up review:

```bash
curl -X POST http://localhost:3456/api/tasks/<review-task-id>/prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "Please re-review — I have addressed your feedback."}'
```

### Send review findings to a parent task (review agents)

If you are a review task with a parent, forward your findings:

```bash
curl -X POST http://localhost:3456/api/tasks/<parent-task-id>/prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "## Review Findings\n\n- Issue 1: ...\n- Issue 2: ..."}'
```

### Check your worktree and branch

Your task's worktree path and branch are in the task record:

```bash
curl http://localhost:3456/api/tasks/$TANGERINE_TASK_ID | jq '{branch, worktreePath, status}'
```

## Task Types

| Type | Behavior |
|------|----------|
| `code` | Default. Agent writes code, pushes branch, creates PR. |
| `review` | Agent reviews code and shares findings. Does NOT push commits or create PRs. |

Review tasks can target a PR (`branch: "#123"`) or a parent task (`parentTaskId: "abc123"`). When a review task with `parentTaskId` starts, the parent agent is automatically notified with the review task ID.

**Review ↔ Parent messaging flow:**
1. Review task starts → server notifies parent agent
2. Review agent finishes analysis → sends findings to parent via `POST /api/tasks/{parentId}/prompt`
3. Parent addresses feedback → requests re-review via `POST /api/tasks/{reviewId}/prompt`
4. Loop continues until resolved

## Task Object Shape

```json
{
  "id": "abc123",
  "projectId": "my-project",
  "title": "Fix the login bug",
  "description": "...",
  "status": "running",
  "type": "code",
  "parentTaskId": null,
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
