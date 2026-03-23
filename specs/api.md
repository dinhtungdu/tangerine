# API

Hono server on Bun. REST + WebSocket + webhook handlers.

## Endpoints

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks (filterable by status, project, search) |
| GET | `/api/tasks/:id` | Get task details |
| POST | `/api/tasks` | Create task manually |
| POST | `/api/tasks/:id/cancel` | Cancel a task |
| POST | `/api/tasks/:id/done` | Mark task as done |
| POST | `/api/tasks/:id/retry` | Retry a failed or cancelled task (creates new task) |
| DELETE | `/api/tasks/:id` | Delete a terminal task |

#### POST /api/tasks

```json
{
  "title": "Fix login bug",
  "description": "...",
  "projectId": "wordpress-develop",
  "provider": "opencode"
}
```

- `provider`: `"opencode"` (default) or `"claude-code"`
- `projectId`: defaults to first configured project

### Sessions (proxy to agent)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks/:id/messages` | List persisted messages |
| POST | `/api/tasks/:id/prompt` | Send prompt to agent |
| POST | `/api/tasks/:id/chat` | Send prompt + persist user message (returns 202) |
| POST | `/api/tasks/:id/abort` | Abort current agent execution |
| GET | `/api/tasks/:id/diff` | Get file changes |
| GET | `/api/tasks/:id/activities` | Get activity log entries |
| POST | `/api/tasks/:id/server/start` | Start dev server |
| POST | `/api/tasks/:id/server/stop` | Stop dev server |
| GET | `/api/tasks/:id/server/status` | Dev server status |

### Preview

| Method | Path | Description |
|--------|------|-------------|
| GET | `/preview/:id/*` | Proxy to task's dev server preview |

### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/github` | GitHub issue webhook |
| POST | `/webhooks/linear` | Linear webhook (future) |

### Project

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/project` | Get current project config |

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Server health |
| GET | `/api/pool` | VM pool stats (provisioning/active/stopped counts) |
| GET | `/api/vms` | List non-destroyed VMs |
| DELETE | `/api/vms/:id` | Destroy a VM |
| POST | `/api/pool/reconcile` | Force VM reconciliation |
| GET | `/api/images` | List golden images |
| POST | `/api/images/build` | Trigger golden image build |
| POST | `/api/images/build-base` | Build base image |
| GET | `/api/images/build-status` | Image build progress |
| GET | `/api/images/build-log` | Stream build log |
| GET | `/api/config` | Full server config (no credentials) |
| GET | `/api/logs` | Query system logs (filter by level, logger, since) |
| DELETE | `/api/logs` | Clear system logs |

## WebSocket

### Connection

```
WS /api/tasks/:id/ws
```

Single WebSocket per task view. Multiplexes:
- Agent output (AgentEvents relayed)
- Task status changes
- User prompts (alternative to REST POST)

### Messages (server → client)

```typescript
type WsServerMessage =
  | { type: "connected" }
  | { type: "event"; data: unknown }            // AgentEvent from provider
  | { type: "activity"; entry: ActivityEntry }   // Activity log entry (real-time)
  | { type: "status"; status: TaskStatus }       // task status change
  | { type: "error"; message: string }
```

Activity entries are broadcast over WebSocket as they're logged — no polling needed. The web dashboard receives lifecycle events, file changes, and tool calls in real-time.

### Messages (client → server)

```typescript
type WsClientMessage =
  | { type: "prompt"; text: string }
  | { type: "abort" }
```

## Activity Log

Activity entries track task lifecycle events and agent tool usage. Stored in `activity_log` table, broadcast via WebSocket.

### Activity Types

| Type | Events | Description |
|------|--------|-------------|
| `lifecycle` | `task.created`, `task.cancelled`, `task.completed`, `task.failed`, `task.reprovisioning` | Task state changes |
| `lifecycle` | `vm.acquiring`, `vm.acquired`, `ssh.waiting`, `ssh.ready`, `repo.cloning`, `worktree.creating`, `setup.started`, `agent.starting`, `session.ready` | Provisioning steps |
| `lifecycle` | `session.reconnecting`, `session.reconnected`, `agent.reconnecting` | Server restart recovery |
| `lifecycle` | `creds.injected`, `creds.missing` | Credential injection status |
| `lifecycle` | `config.changed` | Model/reasoning config hot-swap |
| `file` | `tool.read`, `tool.write` | Agent file operations (Read, Glob, Grep, Write, Edit) |
| `system` | `tool.bash`, `tool.other` | Agent system operations (Bash, other tools) |

### Tool Tracking (Claude Code)

Claude Code NDJSON events are parsed for `tool_use` content blocks. Each tool call is classified:

```typescript
function classifyTool(toolName: string): { activityType, activityEvent }
  Read/Glob/Grep  → { "file", "tool.read" }
  Write/Edit      → { "file", "tool.write" }
  Bash            → { "system", "tool.bash" }
  *               → { "system", "tool.other" }
```

### DB Schema

```sql
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,        -- lifecycle|file|system
  event TEXT NOT NULL,       -- e.g. "tool.read", "task.created"
  content TEXT NOT NULL,     -- human-readable description
  metadata TEXT,             -- JSON blob (tool args, durations, etc.)
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### System Log Correlation

System logs (`system_logs` table) have a `task_id` column, enabling correlation between structured system logs and task-specific activity.

## SSE Bridge (OpenCode)

For OpenCode tasks, the API server subscribes to OpenCode's SSE stream via tunnel and relays events to WebSocket clients.

For Claude Code tasks, NDJSON events from the subprocess stdout are mapped to `AgentEvent` and relayed similarly.

```
Agent (VM) → SSE/NDJSON → API Server → WebSocket → Browser(s)
```

## Preview Proxy

The `/preview/:id/*` endpoint reverse-proxies requests to the task's dev server running inside the VM (via SSH tunnel).

## Error Handling

- Webhook signature verification failures → 401
- Task not found → 404
- Task not in terminal state (for delete) → 409
- VM/agent errors → 500 with error detail

## CORS

v0: same-origin (Vite dev server proxies to API).
Production: API serves static frontend build.
