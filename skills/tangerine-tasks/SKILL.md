---
name: tangerine-tasks
description: Reference for agents running inside a Tangerine task — API endpoints, env vars, and common workflows.
metadata:
  author: tung
  version: "1.2.0"
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
# Default model is claude-opus-4-6 — override with "model" if user specifies another
curl -X POST $API/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Task title",
    "description": "What to do",
    "source": "cross-project",
    "provider": "claude-code",
    "model": "claude-opus-4-6"
  }'

# Create a task from an existing branch
curl -X POST $API/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Continue work on feature",
    "description": "Pick up where we left off",
    "branch": "feature/my-branch",
    "model": "claude-opus-4-6"
  }'

# Create a task from a PR (resolves to the PR's head branch)
curl -X POST $API/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Review and fix PR feedback",
    "branch": "#123",
    "model": "claude-opus-4-6"
  }'

# Create a continuation task (links to parent for context)
curl -X POST $API/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "my-project",
    "title": "Continue previous work",
    "description": "Pick up from where the parent task left off",
    "parentTaskId": "abc123",
    "model": "claude-opus-4-6"
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

# Ensure orchestrator task for a project (lazy create + auto-start)
curl -X POST $API/api/projects/<project-name>/orchestrator \
  -H "Content-Type: application/json" \
  -d '{"provider": "claude-code"}'
```

### Task Lifecycle

```bash
# Start a dormant task (on-demand session start)
curl -X POST $API/api/tasks/<id>/start
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
    "provider": "claude-code",
    "model": "claude-opus-4-6"
  }'
```

### Check your worktree and branch

Your task's worktree path and branch are in the task record:

```bash
curl http://localhost:3456/api/tasks/$TANGERINE_TASK_ID | jq '{branch, worktreePath, status}'
```

### Get context from a parent task

If your task was created as a continuation (`parentTaskId` set), fetch the parent's conversation for context:

```bash
# Get your task to find parentTaskId
PARENT=$(curl -s http://localhost:3456/api/tasks/$TANGERINE_TASK_ID | jq -r '.parentTaskId')

# Get parent's conversation history
curl http://localhost:3456/api/tasks/$PARENT/messages
```

## Self-Review Before PR

> **REQUIRED — do not skip.** You MUST run this review and fix all issues before calling `gh pr create`. Creating a PR without running this step is a mistake.

Run the self-review using your Bash tool (blocking — waits for completion):

```bash
codex review --base main -c model="gpt-5.4" -c reasoning.effort="xhigh"
```

This is the default. If the user requests a specific model or harness, use that instead:

```bash
# Claude Code
git diff origin/main...HEAD | claude -p "Review this diff. Focus on bugs, logic errors, edge cases, missing error handling, and code quality. List each issue with file path and line reference." --model <model>

# OpenCode
opencode run "Review this diff. Focus on bugs, logic errors, edge cases, missing error handling, and code quality. List each issue with file path and line reference." -m <provider/model> <<< "$(git diff origin/main...HEAD)"
```

When the command finishes:
1. Read the full review output
2. Share it with the user
3. Fix every issue found
4. Only then create the PR

## Task Object Shape

```json
{
  "id": "abc123",
  "projectId": "my-project",
  "title": "Fix the login bug",
  "description": "...",
  "status": "running",
  "parentTaskId": null,
  "provider": "claude-code",
  "branch": "tangerine/abc12345",
  "worktreePath": "/workspace/my-project/worktrees/tangerine-slot-0",
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
