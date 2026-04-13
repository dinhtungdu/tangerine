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

### AgentEvent kinds

| Kind | Description |
|------|-------------|
| `message.streaming` | Partial assistant text (streaming) |
| `message.complete` | Final assistant/narration message |
| `status` | `idle` / `working` state changes |
| `error` | Provider-level error |
| `tool.start` / `tool.end` | Tool call lifecycle |
| `thinking` | Extended thinking content |
| `usage` | Token counts for the completed turn: `{ inputTokens, outputTokens }`. Providers emit this when the data is available. `inputTokens` reflects the total context window consumed (including cache) — suitable for showing context window fill. Persisted to `tasks.input_tokens` / `tasks.output_tokens` and broadcast via WebSocket.

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
  systemPrompt?: string
  model?: string
  reasoningEffort?: string
  resumeSessionId?: string
  env?: Record<string, string>
}
```

`AgentHandle` may also expose `setSystemPrompt()` when the provider can apply provider-native system or developer instructions after startup. Tangerine prefers provider-native system prompt channels over prepending internal notes into the first user message.

## OpenCode

Implementation: `agent/opencode-provider.ts`

- uses the OpenCode SDK / server flow
- supports prompt sending, abort, event subscription, config updates, and provider-native system prompts via a generated OpenCode agent config
- can hot-apply model config changes when supported

## Claude Code

Implementation: `agent/claude-code-provider.ts`

- communicates over stdin/stdout NDJSON
- event parsing lives in `agent/ndjson.ts`
- uses Claude Code system prompt flags at startup / resume
- uses resume sessions when Tangerine restarts or reconfigures a task

## Codex

Implementation: `agent/codex-provider.ts`

- starts `codex app-server`
- communicates over JSON-RPC
- applies Tangerine system instructions through Codex `developerInstructions` on thread start / resume
- preserves the underlying Codex thread through `agent_session_id`
- reapplies `approvalPolicy: "never"` and danger-full-access sandboxing on resume and each turn

## Pi

Implementation: `agent/pi-provider.ts`

- starts `pi` in RPC mode
- applies system prompts through Pi CLI startup flags and the provider RPC hook when available
- preserves the underlying Pi session file through `agent_session_id`

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
