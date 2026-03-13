# Agent Integration

OpenCode in server mode as the agent backend. Bidirectional communication via typed SDK.

## OpenCode Server

Each VM runs `opencode serve` headlessly. Our API server talks to it via SSH tunnel.

### Startup

```bash
# Inside VM, after clone + setup + credential injection
# auth.json already copied to ~/.local/share/opencode/auth.json
# OPENCODE_SERVER_PASSWORD already in environment
cd /workspace/<repo>
opencode serve --port 4096 --hostname 0.0.0.0
```

### SDK Connection

From host, connect via tunneled port:

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk"

const client = createOpencodeClient({
  baseUrl: `http://localhost:${tunnel.opencodePort}`,
})
```

## Session Management

### Create Session

When a task starts:

```typescript
const session = await client.session.create({
  body: { title: task.title }
})
```

### Send Prompt

User sends message from web chat:

```typescript
// Async — don't block, stream via SSE
await client.session.prompt_async({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: userMessage }],
  },
})
```

### Stream Events

Subscribe to OpenCode's SSE stream, relay to browser via WebSocket:

```typescript
const events = await client.event.subscribe()
for await (const event of events.stream) {
  // Relay to connected WebSocket clients
  ws.send(JSON.stringify(event))
}
```

### Abort

User clicks stop:

```typescript
await client.session.abort({ path: { id: sessionId } })
```

### Queue Follow-ups

Prompts sent while agent is working are queued on our API server. When current execution completes (detected via SSE events), next prompt is sent.

## Terminal Attach

Developers can attach to any running session from their terminal:

```bash
opencode attach http://localhost:<tunneled-opencode-port>
```

This gives full TUI access to the same session the web UI shows. Changes are synced — both see the same messages and state.

## Agent Capabilities Inside VM

The agent (via OpenCode) has access to:

- **File read/write** — edit project source code
- **Shell execution** — run builds, tests, dev server
- **Git** — commit, push, create branches
- **gh CLI** — create PRs (with injected token)
- **Project tooling** — whatever's in the golden image (Docker, wp-env, npm, etc.)

## OpenCode Configuration

Pre-baked in golden image at `/home/agent/.config/opencode/opencode.json`:

```json
{
  "model": "anthropic/claude-sonnet-4-20250514",
  "permissions": {
    "auto_approve": ["read", "write", "execute"]
  }
}
```

Project-specific rules/skills can be added via `opencode.json` in the repo root or `.opencode/` directory.

## Key SDK Methods Used

| Method | Purpose |
|--------|---------|
| `session.create()` | New session per task |
| `session.prompt()` | Send prompt (sync, wait for response) |
| `session.prompt_async()` | Send prompt (async, stream via SSE) |
| `session.abort()` | Stop current execution |
| `session.messages()` | Load message history |
| `session.get()` | Session status |
| `session.diff()` | Get file changes |
| `event.subscribe()` | SSE stream for real-time updates |
| `global.health()` | Check if OpenCode server is alive |

## Prompt Async vs Message Endpoint

From the OpenCode server API:

- `POST /session/:id/message` — send prompt, **wait** for full response. Blocks.
- `POST /session/:id/prompt_async` — send prompt, returns `204` immediately. Stream results via `GET /event` SSE.

We use `prompt_async` for the web chat flow (non-blocking), and `message` for programmatic/scripted interactions where we need the result.
