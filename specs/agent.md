# Agent Integration

Multi-provider agent abstraction. OpenCode and Claude Code supported via `AgentProvider` interface.

## Provider Abstraction

`agent/provider.ts` defines the contract all providers implement:

```typescript
type ProviderType = "opencode" | "claude-code"

interface AgentEvent =
  | { kind: "message.streaming"; content: string; messageId?: string }
  | { kind: "message.complete"; role: "assistant" | "user"; content: string; messageId?: string }
  | { kind: "status"; status: "idle" | "working" }
  | { kind: "error"; message: string }

interface AgentHandle {
  sendPrompt(text: string): Effect<void, PromptError>
  abort(): Effect<void, AgentError>
  subscribe(onEvent: (e: AgentEvent) => void): { unsubscribe(): void }
  shutdown(): Effect<void, never>
}

interface AgentStartContext {
  taskId: string
  vmIp: string
  sshPort: number
  workdir: string      // worktree path inside VM
  title: string
  previewPort: number
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
- `assistant` with `tool_use` blocks → `status: working`
- `user` (tool results) → `status: working`
- `result` → `message.complete` (or `error` if `is_error`)
- `stream_event` with `content_block_delta` → `message.streaming`
- `system` with `subtype: init` → `status: working`

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

Pre-baked in golden image at `/root/.config/opencode/opencode.json`:

```json
{
  "model": "anthropic/claude-sonnet-4-20250514",
  "permissions": {
    "auto_approve": ["read", "write", "execute"]
  }
}
```

## Terminal Attach (OpenCode only)

```bash
opencode attach http://localhost:<tunneled-opencode-port>
```

Full TUI access to the same session. Not available for Claude Code provider.
