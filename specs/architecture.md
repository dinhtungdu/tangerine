# Architecture

Local background coding agent platform. Agents run in isolated VMs, users interact via web dashboard or terminal. Tasks sourced from GitHub/Linear issues.

## Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Web Dashboard (Vite + React)           │
│  Task list ← GitHub/Linear webhooks                      │
│  Click task → Chat UI + Preview iframe                   │
│  Provider selector (OpenCode / Claude Code)              │
├──────────────────────────────────────────────────────────┤
│                    API Server (Hono + Bun)                │
│  REST: tasks, sessions, projects, VMs                    │
│  WebSocket: real-time chat stream                        │
│  Proxy: preview port forwarding per session              │
│  Webhooks: GitHub issues, Linear (later)                 │
│  Auth: none (v0) → GitHub OAuth + accounts (hosted)      │
├──────────────────────────────────────────────────────────┤
│                Agent Provider Abstraction                 │
│  AgentFactory → AgentHandle (normalized AgentEvent)      │
│  OpenCode: SSE over SSH tunnel                           │
│  Claude Code: NDJSON over SSH stdin/stdout               │
├──────────────────────────────────────────────────────────┤
│                    VM Layer                               │
│  Per-project persistent VMs (ProjectVmManager)           │
│  Lima provisioning, golden image clones                  │
│  Git worktrees for task isolation                        │
│  SSH tunnels: agent API + preview port                   │
├──────────────────────────────────────────────────────────┤
│                    Inside Each VM                         │
│  opencode serve OR claude --stream-json (per task)       │
│  Git worktrees at /workspace/worktrees/<task-prefix>     │
│  Project dev server on configured preview port           │
│  Git + gh CLI (user's token injected via ~/.env)         │
│  Project-specific tooling (Docker, wp-env, etc.)         │
└──────────────────────────────────────────────────────────┘
```

## Key Principles

- **Multi-provider agents**: OpenCode and Claude Code via `AgentFactory`/`AgentHandle` abstraction
- **Per-project persistent VMs**: one VM per project, survives task completion and server restarts
- **Git worktrees for isolation**: each task gets its own worktree, not its own VM
- **Project-agnostic**: each project defines its own golden image, setup, preview port, test command
- **Bidirectional agent comms**: both providers emit normalized `AgentEvent` stream
- **Terminal attach**: devs can `opencode attach` for OpenCode tasks
- **Multiplayer-ready data model**: user_id nullable for v0
- **Local-first**: runs on your machine, no auth for v0. Upgradeable to hosted

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Bun | Fast, native TS, same as hal9999 |
| API | Hono | Lightweight, Bun-native WebSocket via `upgradeWebSocket` |
| Frontend | Vite + React | SPA dashboard, fast HMR, clean separation from API |
| Agent | OpenCode + Claude Code | Dual provider via `AgentFactory` abstraction |
| VM | Lima (macOS) / Incus (Linux) | hal9999's battle-tested providers |
| DB | SQLite (bun:sqlite) | Tasks, VMs, activity logs |

## Structure

```
packages/
  shared/              # @tangerine/shared — types, constants, config schema
    src/
      types.ts         # TaskStatus, VmStatus, ProviderType, WsMessage, etc.
      config.ts        # ProjectConfig, TangerineConfig Zod schemas
      constants.ts     # Status values, default ports, timeouts
  server/              # tangerine-server — Hono API + VM + Agent
    src/
      api/             # Hono routes
      vm/
        providers/     # Lima provider (Provider interface)
        project-vm.ts  # ProjectVmManager (per-project persistent VMs)
        pool.ts        # Legacy VMPoolManager (deprecated)
        tunnel.ts      # SSH tunnel manager
        ssh.ts         # SSH exec, waitForSsh
      agent/
        provider.ts    # AgentFactory, AgentHandle, AgentEvent interfaces
        opencode-provider.ts   # OpenCode agent implementation
        claude-code-provider.ts # Claude Code agent implementation
        ndjson.ts      # NDJSON parser + Claude Code event mapper
        client.ts      # Per-task agent client instances
        events.ts      # SSE subscription for OpenCode
        prompt-queue.ts # Prompt queue (per-task)
      tasks/           # Task lifecycle, cleanup, health, retry, orphan-cleanup
      integrations/    # GitHub polling
      db/              # SQLite schema + queries
      image/           # Golden image build (two-layer: base + project)
      types.ts
web/                   # tangerine-web — Vite + React
  src/
    ...
specs/                 # Architecture and design docs
```

## Specs

| Spec | Scope |
|------|-------|
| [project.md](./project.md) | Project config, golden images, setup |
| [vm.md](./vm.md) | Per-project VMs, ProjectVmManager, worktrees |
| [agent.md](./agent.md) | Multi-provider agent abstraction, AgentHandle API |
| [tasks.md](./tasks.md) | Task lifecycle, retry, cleanup, orphan detection, webhook sources |
| [api.md](./api.md) | HTTP + WebSocket API surface, activity log |
| [cli.md](./cli.md) | CLI commands, credential management |
| [web.md](./web.md) | Dashboard UI, chat, preview, provider selector |
| [credentials.md](./credentials.md) | Auth, token injection, Claude Code OAuth |
| [testing.md](./testing.md) | Testing inside VMs |
| [claude-code-protocol.md](./claude-code-protocol.md) | Claude Code stream-json protocol details |

## What We Reuse from hal9999

- VM provisioning (Lima/Incus providers, `Provider` interface)
- Golden image build pipeline (two-layer: base + project)
- SSH exec layer (`sshExec`, `sshExecStreaming`, `waitForSsh`)
- DB patterns (SQLite schema, typed queries)

## What We Don't Reuse

- Warm pool management (replaced by per-project persistent VMs)
- Fire-and-forget orchestrator (replaced by bidirectional agent abstraction)
- Agent presets/wrapper scripts (replaced by `AgentFactory` providers)
- Poll-based output (replaced by SSE/NDJSON streaming)
- hal9999's task manager (replaced by our own with webhook integration)
