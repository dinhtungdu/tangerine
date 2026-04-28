# Architecture

Tangerine is a local background coding agent platform. The target ACP-only implementation runs on a single machine: the Bun server, SQLite database, git repos, worktrees, and ACP agent subprocesses all live in the same environment.

## Overview

```text
┌─────────────────────────────────────────────────────────────┐
│ Web Dashboard (Vite + React)                               │
│ Runs list, task detail, status page, project switcher      │
├─────────────────────────────────────────────────────────────┤
│ API Server (Hono + Bun)                                    │
│ REST routes, WebSocket streams, static asset serving       │
├─────────────────────────────────────────────────────────────┤
│ Task Runtime                                                │
│ Task manager, lifecycle, retry, health, PR monitor         │
│ Worktree pool, prompt queue, orphan cleanup                │
├─────────────────────────────────────────────────────────────┤
│ ACP Agent Runtime                                           │
│ Configured ACP-compatible commands over stdio              │
│ Thin ACP client wrapper behind task lifecycle              │
├─────────────────────────────────────────────────────────────┤
│ Persistence + Workspace                                     │
│ SQLite + git repos + per-task worktrees                    │
└─────────────────────────────────────────────────────────────┘
```

## Key Principles

- Local-first: Tangerine runs locally and serves the built web app itself
- Single-machine architecture: no VM provisioning, SSH tunneling, or preview port forwarding in the active design
- Single-user remote access uses a shared bearer token when the server is reachable over LAN/Tailscale
- ACP-only agent integration: Tangerine is the ACP client; agents are configured ACP commands
- Git worktree isolation per task
- Project-agnostic setup through per-project config (with archive/unarchive support)
- Typed task model: source, type, capabilities, provider, model, reasoning effort
- Recoverable sessions: restart, reconnect, retry, and orphan cleanup are first-class paths

## Stack

| Layer | Choice |
|-------|--------|
| Runtime | Bun |
| API | Hono |
| Frontend | Vite + React |
| Database | SQLite (`bun:sqlite`) |
| Agent CLIs | ACP-compatible commands over stdio |
| Shared validation | Zod |

## Source Layout

```text
packages/
  shared/src/
    config.ts
    constants.ts
    types.ts
  server/src/
    agent/
    api/
      routes/
    cli/
    db/
    integrations/
    tasks/
  web/src/
    components/
    context/
    hooks/
    lib/
    pages/
skills/
specs/
```

## Core Runtime Flow

1. A task is created through the API, web UI, GitHub webhook/poller, or cross-project prompt.
2. `tasks/manager.ts` assigns task type capabilities and starts tasks.
3. `tasks/lifecycle.ts` fetches the repo, allocates a worktree slot, creates a branch/worktree, and starts the configured ACP agent process locally.
4. ACP `session/update` events are mapped and forwarded to WebSocket clients, activity logs, session logs, and in-memory active stream snapshots for mid-turn task reloads.
5. Task row mutations emit task-list WebSocket invalidations so the dashboard refreshes runs/sidebar data without interval polling.
6. The task can be prompted, aborted, reconfigured, retried, completed, cancelled, or reconnected after restart.
7. Crons are separate entities that fire on a cron schedule, spawning regular worker tasks.

## Access Model

- The dashboard and API are single-user, not anonymous
- When `TANGERINE_AUTH_TOKEN` is configured, all task-observing and task-mutating REST routes require `Authorization: Bearer <token>`
- Task event WebSockets and terminal WebSockets authenticate immediately after connect with an auth message and use app-level ping/pong keepalives so mobile/Tailscale HTTPS paths fail fast and reconnect cleanly
- `GET /api/health` and `GET /api/auth/session` stay public so the UI can probe server state before login
- If the server binds a non-loopback host and no auth token is configured, startup must fail unless the operator explicitly opts into insecure mode

## Data Model

The main persisted tables are:

- `tasks`
- `session_logs`
- `activity_log`
- `system_logs`
- `worktree_slots`

Notable task fields in the active schema:

- `type` — "worker" (worktree + branch + PR tracking), "reviewer" (PR review on a reviewer-local branch while `branch` stores the PR source for PR tracking), "runner" (no worktree, runs on project root, no PR tracking, agent self-completes). Unknown persisted type values normalize to runner for legacy compatibility.
- `provider` — migration-compatible selected ACP agent id
- `model` — selected from ACP session config option category `model` when available
- `reasoning_effort` — selected from ACP session config option category `thought_level` or `effort` when available
- `branch`
- `worktree_path`
- `parent_task_id`
- `agent_session_id`
- `agent_pid`
- `last_seen_at`
- `last_result_at`
- `capabilities`
- `context_tokens` — current ACP-reported context usage
- `context_window_max` — current ACP-reported context capacity when available

## Major Subsystems

### ACP Agent Runtime

Tangerine should not maintain provider-specific agent protocols. The runtime owns one ACP client wrapper that:

- spawns a configured ACP-compatible command over stdio
- initializes ACP protocol version 1
- creates/resumes/loads/closes ACP sessions
- sends prompt turns and cancellation notifications
- handles permission callbacks using Tangerine's unattended policy
- maps ACP streaming updates into Tangerine task events
- applies model/reasoning/mode changes through ACP `session/set_config_option`

Legacy provider runtime files have been removed. See [ACP Migration](./acp-migration.md).

### Task Management

- `tasks/manager.ts` handles task creation, type-based capabilities, retries, completion, cancellation, config changes, and restart recovery.
- `tasks/retry.ts` wraps session start and reconnect flows.
- `tasks/health.ts` suspends idle tasks and revives unhealthy sessions.
- `tasks/pr-monitor.ts` detects and records PR URLs.
- `tasks/orphan-cleanup.ts` removes leftover worktrees for terminal tasks.

### API Surface

The API is organized under `packages/server/src/api/routes/`:

- `tasks.ts`
- `sessions.ts`
- `project.ts`
- `system.ts`
- `ws.ts`
- `terminal-ws.ts`
- `test.ts`

The server also serves the built dashboard from `web/dist`.

### Web App

The dashboard currently exposes:

- Runs list at `/`
- New run page at `/new`
- Status page at `/status`
- Task detail at `/tasks/:id`

Notable UI features:

- project switching (archived projects sorted to collapsible section)
- auth gate when `TANGERINE_AUTH_TOKEN` is enabled
- project archive/unarchive
- diff viewer
- terminal pane
- model/harness/reasoning selectors
- predefined prompt editors
- project update status and pull-latest controls

## Related Specs

- [agent.md](./agent.md)
- [api.md](./api.md)
- [tasks.md](./tasks.md)
- [web.md](./web.md)
- [cli.md](./cli.md)
- [v1-local-server.md](./v1-local-server.md)
