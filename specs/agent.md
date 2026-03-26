# Agent Integration

Multi-provider agent abstraction. OpenCode and Claude Code supported via `AgentProvider` interface.

## Provider Abstraction

`agent/provider.ts` defines the contract all providers implement:

```typescript
type ProviderType = "opencode" | "claude-code"

type AgentEvent =
  | { kind: "message.streaming"; content: string; messageId?: string }
  | { kind: "message.complete"; role: "assistant" | "user"; content: string; messageId?: string }
  | { kind: "status"; status: "idle" | "working" }
  | { kind: "error"; message: string }
  | { kind: "tool.start"; toolName: string; toolInput?: string }
  | { kind: "tool.end"; toolName: string; toolResult?: string }
  | { kind: "thinking"; content: string }

interface AgentConfig {
  model?: string
  reasoningEffort?: string
}

interface AgentHandle {
  sendPrompt(text: string): Effect<void, PromptError>
  abort(): Effect<void, AgentError>
  subscribe(onEvent: (e: AgentEvent) => void): { unsubscribe(): void }
  shutdown(): Effect<void, never>
  /** Hot-swap config without restart. Returns true if applied. Falls back to restart if not implemented. */
  updateConfig?(config: AgentConfig): Effect<boolean, AgentError>
}

interface AgentStartContext {
  taskId: string
  vmIp: string
  sshPort: number
  workdir: string      // worktree path inside VM
  title: string
  previewPort: number
  model?: string              // e.g. "claude-sonnet-4-6" or "anthropic/claude-sonnet-4-6"
  reasoningEffort?: string    // "low" | "medium" | "high"
  resumeSessionId?: string   // resume existing session (Claude Code --resume)
}

interface AgentFactory {
  start(ctx: AgentStartContext): Effect<AgentHandle, SessionStartError>
}
```

## OpenCode Provider (`opencode-provider.ts`)

Spawns `opencode serve` inside VM, establishes SSH tunnel, creates a session, bridges SSE events.

### Startup

```bash
# Inside VM (sources ~/.env for API keys first)
test -f ~/.env && set -a && . ~/.env && set +a
cd /workspace/worktrees/<task-prefix>
opencode serve --port 4096 --hostname 0.0.0.0
```

### Communication

1. SSH tunnel from host to VM port 4096
2. REST API via tunnel: create session, send prompts (`prompt_async`), abort
3. SSE stream from `GET /event` relayed to subscribers via `AgentEvent`

### Event Mapping

OpenCode SSE events → `AgentEvent`:
- `message.part.updated` → `message.streaming` (accumulates text per message ID)
- `message.updated` (with `time.completed`) → `message.complete`
- `session.status` → `status` (idle/working)

### Metadata

`AgentHandleWithMeta` extends `AgentHandle` with `__meta: { sessionId, agentPort, previewPort }`. Retrieved via `getHandleMeta(handle)`.

## Claude Code Provider (`claude-code-provider.ts`)

Spawns `claude` CLI inside VM via SSH with stdin/stdout piping. No tunnel, no HTTP, no port allocation.

### Startup

```bash
ssh -T -p <sshPort> root@<vmIp> \
  "test -f ~/.env && set -a && . ~/.env && set +a; \
   cd /workspace/worktrees/<task-prefix> && \
   claude --output-format stream-json --input-format stream-json \
          --verbose --session-id <uuid> --dangerously-skip-permissions"
```

### Communication

- **Prompts**: JSON written to stdin: `{"type":"user","message":{"role":"user","content":"..."}}`
- **Events**: NDJSON from stdout, parsed by `ndjson.ts`
- **Abort**: `SIGINT` to SSH process

### Event Mapping (`ndjson.ts`)

Claude Code stream-json events → `AgentEvent`:
- `assistant` with text content → `message.streaming`
- `assistant` with `tool_use` blocks → `tool.start` (per tool) + `status: working`
- `assistant` with `thinking` blocks → `thinking`
- `user` (tool results) → `tool.end` (per tool) + `status: working`
- `result` → `message.complete` (or `error` if `is_error`)
- `stream_event` with `content_block_delta` → `message.streaming`
- `system` with `subtype: init` → `status: working`

### Session Resume

When `resumeSessionId` is set in `AgentStartContext`, Claude Code is started with `--resume`:

```bash
claude --output-format stream-json --input-format stream-json \
       --verbose --resume --session-id <existing-uuid> \
       --dangerously-skip-permissions
```

Used for server restart recovery and model config changes (shutdown + restart with same session).

## Provider Selection

`POST /api/tasks` accepts optional `provider` field (`"opencode" | "claude-code"`). Default comes from project config's `defaultProvider` field (defaults to `"opencode"`).

## Session Management

### Prompt Queue

Per-task queue. Prompts sent while agent is working are queued on the API server. When agent goes idle (detected via `AgentEvent` status), next prompt is sent.

### Agent Capabilities Inside VM

Both providers have access to:
- **File read/write** — edit project source code
- **Shell execution** — run builds, tests, dev server
- **Git** — commit, push, create branches
- **gh CLI** — create PRs (with injected token)
- **Project tooling** — whatever's in the golden image

## OpenCode Configuration

The OpenCode provider auto-creates `~/.config/opencode/opencode.json` before first server spawn with permissions that allow headless operation:

```json
{
  "agent": {
    "build": {
      "permission": {
        "external_directory": "allow",
        "doom_loop": "allow"
      }
    }
  }
}
```

This allows the `build` agent to access paths outside the project dir (e.g. `/tmp/*`) and continue past doom-loop detection without user approval — both safe in a sandbox VM.

As a safety net, the provider also subscribes to `permission.asked` SSE events and auto-approves them via `POST /session/{id}/permissions/{permissionId}` with `{"response": "always"}`.

## Model / Config Changes

`POST /api/tasks/:id/model` changes model or reasoning effort for a running task:

1. Try `handle.updateConfig()` (hot-swap — works for OpenCode)
2. If not supported or fails → shutdown agent + restart with `--resume` and new config (Claude Code path)
3. Update task record with new model/reasoning_effort

## Terminal Attach (OpenCode only)

```bash
opencode attach http://localhost:<tunneled-opencode-port>
```

Full TUI access to the same session. Not available for Claude Code provider.
