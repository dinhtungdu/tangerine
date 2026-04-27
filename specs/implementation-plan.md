# Implementation Plan

Phased build plan for Tangerine v0. Status: **implemented**.

## Workspace Setup

Bun workspaces with shared types between API server and web dashboard.

### Package Layout

```
packages/
  shared/              # @tangerine/shared — types, constants, config schema
    src/
      types.ts         # TaskStatus, VmStatus, ProviderType, WsMessage, ActivityEntry, etc.
      config.ts        # ProjectConfig, TangerineConfig Zod schemas
      constants.ts     # Status values, default ports, timeouts
  server/              # tangerine-server — Hono API + VM + Agent
    src/
      api/             # Hono routes
      agent/           # ACP client wrapper and prompt queue
      tasks/           # Task lifecycle, cleanup, health, retry
      integrations/    # GitHub polling
      db/              # SQLite schema + queries
      image/           # Golden image templates + build (two-layer)
web/                   # tangerine-web — Vite + React
```

### Shared Types (`@tangerine/shared`)

Core types consumed by both server and web:

- `TaskStatus`: `"created" | "provisioning" | "running" | "done" | "failed" | "cancelled"`
- `ProviderType`: configured ACP agent ID string
- `Task`: full task object shape (includes compatibility `provider`, `worktreePath`, `agentSessionId`)
- `ActivityEntry`: activity log entries
- `WsServerMessage`: task/chat/config/plan/content WebSocket events
- `WsClientMessage`: prompt/abort/client control events
- `ProjectConfig`: Zod schema with `defaultAgent` field

---

## Phase 0: Agent Runtime Spike — DONE

Legacy provider spike superseded by ACP stdio runtime.

## Phase 1: Foundation — DONE

Project scaffolding, DB schema (tasks with `provider`, `worktree_path`, `agent_session_id`; VMs with `project_id`), config loading, VM layer extraction from hal9999.

## Phase 2: VM + Agent Wiring — DONE

- Git worktree isolation per task
- ACP agent abstraction (`AgentFactory` → `AgentHandle`)
- Session lifecycle: fetch repo → acquire worktree → inject env → start ACP agent
- Cleanup: persist messages → shutdown agent → remove worktree

## Phase 3: API + Real-time — DONE

- REST endpoints: tasks CRUD, sessions, VMs, images, system logs
- WebSocket relay: AgentEvent → WS → browser
- Preview proxy
- GitHub webhook handler
- Image build endpoints (base + project layers)

## Phase 4: Web Dashboard — DONE

- Task list with status, provider badge
- Task detail: chat + preview + activity log
- Provider selector in task creation
- VM summary card
- Streaming chat UI

## Phase 5: Multi-Provider + Polish — DONE

- Claude Code provider: SSH stdin/stdout + NDJSON
- NDJSON parser (`ndjson.ts`) + event mapping
- `CLAUDE_CODE_OAUTH_TOKEN` credential injection
- Server restart reconciliation (`reconcileOnStartup`)
- Error recovery + retry
- System logging (DB-backed)

---

## Critical Path (completed)

```
Spike → DB + VM extract → Session lifecycle → WebSocket relay → Chat UI → Claude Code provider
```

## Testing Strategy

- **Unit**: DB queries, prompt queue, config parsing, pool logic (mock provider)
- **Architecture**: structural rules enforced in `web/src/__tests__/architecture.test.ts`
- **Integration**: session lifecycle against real Lima VMs (manual)
- **E2E**: full flow manual testing — create task with either provider, chat, preview
- **API**: Hono route contracts in `packages/server/src/__tests__/api-routes.test.ts`
