# Architecture

Tangerine is a local background coding agent platform. The current implementation runs on a single machine: the Bun server, SQLite database, git repos, worktrees, and agent CLIs all live in the same environment.

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
│ Agent Providers                                             │
│ OpenCode | Claude Code | Codex                             │
│ Local subprocesses behind a shared AgentFactory API        │
├─────────────────────────────────────────────────────────────┤
│ Persistence + Workspace                                     │
│ SQLite + git repos + per-task worktrees                    │
└─────────────────────────────────────────────────────────────┘
```

## Key Principles

- Local-first: Tangerine runs locally and serves the built web app itself
- Single-machine architecture: no VM provisioning, SSH tunneling, or preview port forwarding in the active design
- Single-user remote access uses a shared bearer token when the server is reachable over LAN/Tailscale
- Multi-provider agents behind a shared abstraction
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
| Agent CLIs | OpenCode, Claude Code, Codex |
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
2. `tasks/manager.ts` assigns task type capabilities and starts non-orchestrator tasks immediately.
3. `tasks/lifecycle.ts` fetches the repo, allocates a worktree slot, creates a branch/worktree, and starts the provider process locally.
4. Provider events are normalized and forwarded to WebSocket clients, activity logs, and session logs.
5. The task can be prompted, aborted, reconfigured, retried, completed, cancelled, or reconnected after restart.
6. Crons are separate entities that fire on a cron schedule, spawning regular worker tasks.

## Access Model

- The dashboard and API are single-user, not anonymous
- When `TANGERINE_AUTH_TOKEN` is configured, all task-observing and task-mutating REST routes require `Authorization: Bearer <token>`
- Task event WebSockets and terminal WebSockets authenticate immediately after connect with an auth message
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

- `type` — "worker" (worktree + branch + PR tracking), "orchestrator" (system coordinator), "reviewer" (PR review), "runner" (no worktree, runs on project root, no PR tracking, agent self-completes)
- `provider`
- `model`
- `reasoning_effort`
- `branch`
- `worktree_path`
- `parent_task_id`
- `agent_session_id`
- `agent_pid`
- `last_seen_at`
- `last_result_at`
- `capabilities`

## Major Subsystems

### Agent Providers

- `opencode-provider.ts`
- `claude-code-provider.ts`
- `codex-provider.ts`
- `pi-provider.ts`

All providers implement the shared contract in `agent/provider.ts`, emit normalized events, and support prompt delivery plus shutdown. OpenCode exposes a richer live update path; Claude Code, Codex, and Pi use subprocess streams. Pi uses its own RPC protocol over stdin/stdout NDJSON. On abort and shutdown, providers kill the entire process tree (agent + all descendant subprocesses) via `agent/process-tree.ts` to prevent orphaned bash commands.

Provider identity is centralized in `@tangerine/shared` via `SUPPORTED_PROVIDERS`, with `DEFAULT_PROVIDER` as the shared fallback. Each provider module owns its metadata, and the server aggregates that metadata for both provider factories and CLI flows such as skill installation.

### Task Management

- `tasks/manager.ts` handles task creation, type-based capabilities, retries, completion, cancellation, config changes, orchestrator creation, and restart recovery.
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
- orchestrator entry point
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
