# Orchestrator Chat

Project-level conversational interface for planning and creating tasks. Replaces manual form-filling with "tell me what you want done."

## Concept

A real coding agent (Claude Code) running at the project's repo root on main. It can read the codebase, git history, and open PRs for context. It doesn't write code — it creates and monitors tasks that do.

## How It Works

```
User: "Refactor auth to use prepared statements"
  ↓
Orchestrator (Claude Code @ repo root on main)
  ├─ Reads codebase to understand scope
  ├─ Decomposes into tasks
  ├─ POST /api/tasks (×N)
  └─ Monitors progress, reports back
```

## Session Model

- One orchestrator session per project (long-lived)
- Runs on the project's VM at the repo root (no worktree, stays on main)
- Has Tangerine API access via reverse tunnel (same as cross-project tasks)
- Persists conversation history (new table: `orchestrator_sessions`)

## Agent Setup

Provider: Claude Code. System prompt includes:
- Project config (repo, setup, test commands, default provider/model)
- Recent task history (last N tasks + outcomes)
- Available providers and models

Tools (via MCP or system prompt instructions):
- `tangerine-task create` — create tasks
- `tangerine-task status` — check task status
- `tangerine-task list` — list recent tasks
- Read-only codebase access (Glob, Grep, Read — no Edit, no Write, no Bash)

## Data Model

```sql
CREATE TABLE orchestrator_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Reuse session_logs table with orchestrator session ID as task_id
-- Tasks created by orchestrator get parent_task_id = orchestrator_session_id
```

## API

```
POST   /api/projects/:name/orchestrator       -- create/resume session
WS     /api/projects/:name/orchestrator/ws     -- chat stream (same protocol as task WS)
DELETE /api/projects/:name/orchestrator         -- end session
```

## Web UI

- New route: `/projects/:name` — project page with orchestrator chat
- Reuses `ChatPanel`, `ChatMessage`, `ChatInput` components
- Shows spawned tasks inline (status badges, links to task detail)
- Task creation events appear as activity items in the chat

## What It Doesn't Do

- Write code (tasks do that)
- Create branches or worktrees
- Run tests or builds
- Replace the manual task creation form (that stays as a power-user escape hatch)
