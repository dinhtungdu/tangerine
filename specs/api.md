# API

Tangerine exposes a Hono API on Bun. The current server provides REST routes, per-task WebSocket streams, terminal WebSocket streams, GitHub webhooks, test-only endpoints, and static serving for the built dashboard.

## Authentication

Tangerine uses a single shared bearer token for remote single-user access when `TANGERINE_AUTH_TOKEN` is configured.

- Browser and CLI REST clients send `Authorization: Bearer <token>`
- Browser WebSocket clients authenticate immediately after connect with an auth message before subscribing or opening a terminal
- `GET /api/health` and `GET /api/auth/session` are public
- GitHub webhooks stay protected by webhook HMAC, not bearer auth

## REST Endpoints

Unknown `/api/*` paths return JSON 404 responses and never fall through to the web app SPA fallback.

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks. Supports `status`, `project`, and `search` query params |
| GET | `/api/tasks/:id` | Get one task |
| POST | `/api/tasks` | Create a task |
| GET | `/api/tasks/:id/children` | List child tasks |
| GET | `/api/tasks/:id/files` | List existing files in the task worktree for `@` file mentions. Falls back to committed project files before a worktree exists. Supports `query` |
| POST | `/api/tasks/:id/cancel` | Cancel a task |
| POST | `/api/tasks/:id/resolve` | Resolve a failed/cancelled task |
| POST | `/api/tasks/:id/retry` | Retry a failed or cancelled task by creating a new one |
| POST | `/api/tasks/:id/start` | Start a dormant task |
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
  "branch": "feature/pr-123",
  "prUrl": "https://github.com/org/repo/pull/123",
  "parentTaskId": "task-abc"
}
```

Current provider values are configured ACP agent IDs from top-level `agents[]`; default fallback ID is `acp`. Legacy provider IDs are rejected unless explicitly configured as ACP agent IDs.

If `provider` is omitted, task creation resolves `project.defaultAgent`, then top-level `defaultAgent`, then `acp`. `project.defaultProvider` is accepted only as deprecated migration input.

Current task types:

- `worker`
- `reviewer`
- `runner`

Unknown persisted task-type values normalize to `runner` for legacy compatibility. Public task creation accepts only `worker`, `reviewer`, and `runner`.

### Auth

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/session` | Return whether auth is enabled and whether the current client is authenticated |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks/:id/messages` | List persisted session messages (including optional `message_id`) plus any transient in-flight assistant/thinking stream snapshot |
| GET | `/api/tasks/:id/images/:filename` | Serve stored task images |
| POST | `/api/tasks/:id/prompt` | Send a prompt |
| POST | `/api/tasks/:id/chat` | Send a prompt and return `202` immediately |
| POST | `/api/tasks/:id/abort` | Abort the current run |
| GET | `/api/tasks/:id/queue` | List queued prompts waiting for the current turn to finish; queued prompts are persisted to session logs only when delivered to the agent |
| PATCH | `/api/tasks/:id/queue/:promptId` | Edit queued prompt text/images before delivery |
| DELETE | `/api/tasks/:id/queue/:promptId` | Remove a queued prompt |
| POST | `/api/tasks/:id/queue/:promptId/send-now` | Atomically remove queued prompt from queue and send immediately; aborts current work if agent is busy |
| POST | `/api/tasks/:id/model` | Change model, reasoning effort, and/or ACP mode |
| GET | `/api/tasks/:id/config-options` | Return active ACP session config options |
| GET | `/api/tasks/:id/slash-commands` | Return active ACP slash commands for `/` autocomplete |
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
| GET | `/api/projects/:name/files` | List committed project files for new-task `@` file mentions. Untracked slot-0 files are excluded because new task worktrees cannot resolve them. Supports `query` |
| GET | `/api/projects/:name/update-status` | Read cached self-update status |
| POST | `/api/projects/:name/update` | Pull latest and optionally run `postUpdateCommand` |

`GET /api/projects` response includes `sshHost`, `sshUser`, and `editor` (`"vscode"|"cursor"|"zed"`) from the top-level config (all optional). Used by the web UI to render SSH deep-links for opening worktrees in the user's editor on the host machine.

`GET /api/projects` returns:

- `agents`: configured ACP agents from top-level config
- `defaultAgent`: top-level default ACP agent ID, when set
- `systemCapabilities`: installed/authenticated tool and ACP agent command status

Provider metadata, model discovery, and context-window maps are not exposed. Model/reasoning/mode selectors use per-session ACP config options from `GET /api/tasks/:id/config-options` and `config.options` WebSocket events. Reasoning controls use `category: "thought_level"` or extension category `"effort"`. For ACP agents that expose legacy session `models` / `modes`, the server normalizes them into the same config-options shape. Legacy `modes` that are semantic thinking/reasoning levels are exposed as `category: "thought_level"` but still update through `session/set_mode`.

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

Task event payloads include legacy normalized chat/activity events plus ACP-derived events. Streaming events always include a stable `messageId`; if the ACP adapter omits one, Tangerine generates one per active turn so REST snapshots and later WebSocket chunks merge in the UI.

- `{ event: "config.options", configOptions }` for ACP session config selectors
- `{ event: "slash.commands", commands }` for ACP `/` slash-command autocomplete
- `{ event: "thinking.streaming", messageId, content }` for transient thought chunks
- `{ event: "thinking.complete", messageId, role: "thinking", content }` for persisted thought messages (one per provider segment; messageId changes, visible interleaving events, or no-`messageId` sentence boundaries start new segments)
- `{ event: "plan", entries }` for ACP plan cards
- `{ event: "content.block", block }` for ACP non-text content blocks
- `{ event: "usage", contextTokens, contextWindowMax }` for ACP context-window usage

Server messages match the shared type shape:

```typescript
type WsServerMessage =
  | { type: "connected" }
  | { type: "event"; data: unknown }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "status"; status: TaskStatus }
  | { type: "agent_status"; agentStatus: "idle" | "working" }
  | { type: "task_agent_status"; taskId: string; agentStatus: "idle" | "working" }
  | { type: "task_changed"; taskId: string; change: "created" | "updated" | "deleted" }
  | { type: "queue"; queuedPrompts: PromptQueueEntry[] }
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

Prompt text may contain `@relative/path` file mentions. The server resolves existing files within the task worktree and sends them to ACP agents as `resource_link` prompt blocks.

When bearer auth is enabled, the client must send the auth message before any prompt or terminal input.

The server also sends periodic `{ type: "ping" }` keepalives. Browser clients must reply with `{ type: "pong" }`. This keeps mobile/Tailscale HTTPS connections from going half-open silently and gives both sides a fast reconnect path.

### Task List Stream

```text
WS /api/tasks/list/ws
```

The runs list/sidebar use this global stream for live invalidation instead of interval polling. It sends:

- `{ type: "connected" }` on connection
- `{ type: "task_agent_status", taskId, agentStatus }` for active agent status changes
- `{ type: "task_changed", taskId, change }` for task row creates, list-visible updates, and deletes

### Terminal Stream

```text
WS /api/tasks/:id/terminal
```

`/terminal` backs the dashboard command terminal pane and starts a shell in the task worktree.

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
