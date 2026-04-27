# API

Tangerine exposes a Hono API on Bun. The current server provides REST routes, per-task WebSocket streams, terminal WebSocket streams, GitHub webhooks, test-only endpoints, and static serving for the built dashboard.

## Authentication

Tangerine uses a single shared bearer token for remote single-user access when `TANGERINE_AUTH_TOKEN` is configured.

- Browser and CLI REST clients send `Authorization: Bearer <token>`
- Browser WebSocket clients authenticate immediately after connect with an auth message before subscribing or opening a terminal
- `GET /api/health` and `GET /api/auth/session` are public
- GitHub webhooks stay protected by webhook HMAC, not bearer auth

## REST Endpoints

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks. Supports `status`, `project`, and `search` query params |
| GET | `/api/tasks/:id` | Get one task |
| POST | `/api/tasks` | Create a task |
| GET | `/api/tasks/:id/children` | List child tasks |
| POST | `/api/tasks/:id/cancel` | Cancel a task |
| POST | `/api/tasks/:id/resolve` | Resolve a task |
| POST | `/api/tasks/:id/retry` | Retry a failed or cancelled task by creating a new one |
| POST | `/api/tasks/:id/start` | Start a dormant task, used for on-demand orchestrators |
| POST | `/api/tasks/:id/seen` | Mark task as seen |
| POST | `/api/tasks/:id/done` | Mark task complete |
| PATCH | `/api/tasks/:id` | Update agent-writable fields such as `prUrl` |
| DELETE | `/api/tasks/:id` | Delete a terminal task after cleanup |

`POST /api/tasks` accepts:

```json
{
  "projectId": "my-project",
  "title": "Review PR #123",
  "type": "reviewer",
  "description": "Check for regressions",
  "provider": "acp",
  "model": "gpt-5",
  "reasoningEffort": "high",
  "source": "cross-project",
  "branch": "#123",
  "parentTaskId": "task-abc"
}
```

Current provider values are configured ACP agent IDs from top-level `agents[]`; default fallback ID is `acp`. Legacy provider IDs are rejected unless explicitly configured as ACP agent IDs.

If `provider` is omitted, task creation resolves `project.defaultAgent`, then top-level `defaultAgent`, then `acp`. `project.defaultProvider` is accepted only as deprecated migration input.

Current task types:

- `worker`
- `orchestrator`
- `reviewer`

### Auth

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/session` | Return whether auth is enabled and whether the current client is authenticated |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks/:id/messages` | List persisted session messages |
| GET | `/api/tasks/:id/images/:filename` | Serve stored task images |
| POST | `/api/tasks/:id/prompt` | Send a prompt |
| POST | `/api/tasks/:id/chat` | Send a prompt and return `202` immediately |
| POST | `/api/tasks/:id/abort` | Abort the current run |
| POST | `/api/tasks/:id/model` | Change model, reasoning effort, and/or ACP mode |
| GET | `/api/tasks/:id/config-options` | Return active ACP session config options |
| GET | `/api/tasks/:id/diff` | Return parsed git diff files |
| GET | `/api/tasks/:id/activities` | List activity log entries |

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List configured projects, ACP agents, capabilities, and SSH editor config |
| GET | `/api/projects/:name` | Get one project |
| POST | `/api/projects` | Register a project |
| PUT | `/api/projects/:name` | Update a project |
| DELETE | `/api/projects/:name` | Remove a project |
| POST | `/api/projects/:name/orchestrator` | Ensure the project has an orchestrator task |
| GET | `/api/projects/:name/update-status` | Read cached self-update status |
| POST | `/api/projects/:name/update` | Pull latest and optionally run `postUpdateCommand` |

`GET /api/projects` response includes `sshHost`, `sshUser`, and `editor` (`"vscode"|"cursor"|"zed"`) from the top-level config (all optional). Used by the web UI to render SSH deep-links for opening worktrees in the user's editor on the host machine.

`GET /api/projects` returns:

- `agents`: configured ACP agents from top-level config
- `defaultAgent`: top-level default ACP agent ID, when set
- `systemCapabilities`: installed/authenticated tool and ACP agent command status

Provider metadata, model discovery, and context-window maps are not exposed. Model/reasoning/mode selectors use per-session ACP config options from `GET /api/tasks/:id/config-options` and `config.options` WebSocket events.

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Basic server health |
| GET | `/api/logs` | Query system logs |
| DELETE | `/api/logs` | Clear system logs |
| GET | `/api/cleanup/orphans` | List orphaned task worktrees |
| POST | `/api/cleanup/orphans` | Clean orphaned task worktrees |
| GET | `/api/config` | Return validated config without credentials |

### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/github` | GitHub issues webhook |

If `integrations.github.webhookSecret` is configured, the route verifies `x-hub-signature-256`.

### Test Mode

When `TEST_MODE=1`, the server also mounts `/api/test/*` routes for deterministic seeded-state tests.
These routes follow the same bearer-token rules as the rest of `/api/*`.

## WebSocket Endpoints

### Task Event Stream

```text
WS /api/tasks/:id/ws
```

Task event payloads include legacy normalized chat/activity events plus ACP-derived events:

- `{ event: "config.options", configOptions }` for ACP session config selectors
- `{ event: "plan", entries }` for ACP plan cards
- `{ event: "content.block", block }` for ACP non-text content blocks

Server messages match the shared type shape:

```typescript
type WsServerMessage =
  | { type: "connected" }
  | { type: "event"; data: unknown }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "status"; status: TaskStatus }
  | { type: "agent_status"; agentStatus: "idle" | "working" }
  | { type: "error"; message: string }
  | { type: "ping" }
```

Client messages:

```typescript
type WsClientMessage =
  | { type: "auth"; token: string }
  | { type: "prompt"; text: string; images?: PromptImage[] }
  | { type: "abort" }
  | { type: "pong" }
```

When bearer auth is enabled, the client must send the auth message before any prompt or terminal input.

The server also sends periodic `{ type: "ping" }` keepalives. Browser clients must reply with `{ type: "pong" }`. This keeps mobile/Tailscale HTTPS connections from going half-open silently and gives both sides a fast reconnect path.

### Terminal Stream

```text
WS /api/tasks/:id/terminal
```

This endpoint backs the dashboard terminal pane.

Server messages:

```typescript
type TerminalWsServerMessage =
  | { type: "connected" }
  | { type: "scrollback"; data: string }
  | { type: "output"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string }
  | { type: "ping" }
```

Client messages:

```typescript
type TerminalWsClientMessage =
  | { type: "auth"; token: string }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "pong" }
```

Like the task event stream, the terminal stream uses app-level ping/pong keepalives so idle shells stay reliable over mobile/Tailscale HTTPS access.

## Response Mapping

- DB task rows are normalized into camelCase API responses
- Timestamps are normalized before JSON responses
- Activity and system logs are exposed directly from SQLite-backed queries

## Error Semantics

- Validation failures return `400`
- Missing or invalid bearer auth returns `401` with `WWW-Authenticate: Bearer`
- Missing tasks/projects return `404`
- Non-terminal delete attempts return `409`
- Unhandled route errors are logged and return `500`

## Static Serving

If `web/dist` exists, the server serves it and falls back to `index.html` for SPA routes.
