# Orchestrator Chat

Project-level conversational interface for planning and creating tasks. Replaces manual form-filling with "tell me what you want done."

## Concept

A regular task that runs in worktree 0 (the repo root, checked out to the default branch). It reads the codebase for context and creates/monitors other tasks instead of writing code.

No new infrastructure. An orchestrator task is just a task that runs in slot 0.

## How It Works

```
User: "Refactor auth to use prepared statements"
  ↓
Orchestrator task (Claude Code @ worktree 0, default branch)
  ├─ Reads codebase to understand scope
  ├─ Decomposes into tasks
  ├─ tangerine-task create (×N)
  └─ Monitors progress, reports back
```

## What Makes It Different From a Normal Task

- Runs in worktree 0 (default branch) instead of getting its own worktree
- System prompt emphasizes planning + task creation over coding
- Has `tangerine-task` access (create, status, list)
- Doesn't branch, doesn't write code

Everything else — chat UI, WebSocket, session logs, activity log — is identical to a normal task.

## What It Doesn't Do

- Write code (tasks do that)
- Create branches or worktrees
- Run tests or builds
- Replace the manual task creation form (that stays as a power-user escape hatch)
