# Agent Integration

Tangerine currently supports four providers through a shared abstraction:

- `opencode`
- `claude-code`
- `codex`
- `pi`

All providers run as local subprocesses and are wrapped behind the interfaces in `packages/server/src/agent/provider.ts`.

## Shared Provider Contract

The provider layer exposes:

- `AgentFactory`
- `AgentHandle`
- normalized `AgentEvent` messages
- prompt images support
- optional hot config updates

Current provider selection type:

```typescript
type ProviderType = "opencode" | "claude-code" | "codex" | "pi"
```

The runtime stores `agent_session_id` and `agent_pid` on tasks so sessions can be resumed or inspected after restart.

## AgentStartContext

The active architecture is local-only. Provider startup context centers on the task and worktree, not VM networking:

```typescript
interface AgentStartContext {
  taskId: string
  workdir: string
  title: string
  model?: string
  reasoningEffort?: string
  resumeSessionId?: string
  env?: Record<string, string>
}
```

## OpenCode

Implementation: `agent/opencode-provider.ts`

- uses the OpenCode SDK / server flow
- supports prompt sending, abort, event subscription, and config updates
- can hot-apply model config changes when supported

## Claude Code

Implementation: `agent/claude-code-provider.ts`

- communicates over stdin/stdout NDJSON
- event parsing lives in `agent/ndjson.ts`
- uses resume sessions when Tangerine restarts or reconfigures a task

## Codex

Implementation: `agent/codex-provider.ts`

- starts `codex app-server`
- communicates over JSON-RPC
- preserves the underlying Codex thread through `agent_session_id`
- reapplies `approvalPolicy: "never"` and danger-full-access sandboxing on resume and each turn

## Event Flow

Provider-specific streams are normalized into a common event shape and then fan out to:

- WebSocket clients
- session log persistence
- activity log classification
- task status / working-state updates

The prompt queue in `agent/prompt-queue.ts` ensures prompts sent while a task is busy are drained in order.

## Config Changes

`POST /api/tasks/:id/model` changes `model` and/or `reasoningEffort` for a running task.

The task manager attempts:

1. provider hot-swap via `updateConfig()`
2. restart-with-resume fallback when hot-swap is unsupported

## Tool Activity Classification

Tool calls are classified into activity log events:

- file reads: `tool.read`
- file writes: `tool.write`
- shell commands: `tool.bash`
- everything else: `tool.other`

This powers the task detail UI and persisted audit trail.

## Skill Discovery

Providers emit an `init` event on session start with discovered skills, tools, and slash commands. The server caches these per-task and pushes them to the UI via WebSocket (`agent_skills` message) and REST (`GET /api/tasks/:id/skills`).

Discovery mechanism per provider:

| Provider | Mechanism |
|----------|-----------|
| `claude-code` | `system/init` event includes `skills[]`, `tools[]`, `slash_commands[]` |
| `pi` | `get_state` response includes `skills[]`, `tools[]`, `slashCommands[]` |
| `opencode` | Filesystem scan of `~/.claude/skills/` (no native API) |
| `codex` | Filesystem scan of `~/.codex/skills/` (no native API) |

The ChatInput UI shows a `/` autocomplete picker sourced from the combined skills + slash commands list.
