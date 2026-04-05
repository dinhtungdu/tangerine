# API

Tangerine exposes a Hono API on Bun. The current server provides REST routes, per-task WebSocket streams, terminal WebSocket streams, GitHub webhooks, test-only endpoints, and static serving for the built dashboard.

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
  "provider": "codex",
  "model": "openai/gpt-5.4",
  "reasoningEffort": "high",
  "source": "cross-project",
  "branch": "#123",
  "parentTaskId": "task-abc"
}
```

Current provider values:

- `opencode`
- `claude-code`
- `codex`
- `pi`

Current task types:

- `worker`
- `orchestrator`
- `reviewer`

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks/:id/messages` | List persisted session messages |
| GET | `/api/tasks/:id/images/:filename` | Serve stored task images |
| POST | `/api/tasks/:id/prompt` | Send a prompt |
| POST | `/api/tasks/:id/chat` | Send a prompt and return `202` immediately |
| POST | `/api/tasks/:id/abort` | Abort the current run |
| POST | `/api/tasks/:id/model` | Change model and/or reasoning effort |
| GET | `/api/tasks/:id/diff` | Return parsed git diff files |
| GET | `/api/tasks/:id/activities` | List activity log entries |

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List configured projects, available models, and SSH editor config |
| GET | `/api/projects/:name` | Get one project |
| POST | `/api/projects` | Register a project |
| PUT | `/api/projects/:name` | Update a project |
| DELETE | `/api/projects/:name` | Remove a project |
| POST | `/api/projects/:name/orchestrator` | Ensure the project has an orchestrator task |
| GET | `/api/projects/:name/update-status` | Read cached self-update status |
| POST | `/api/projects/:name/update` | Pull latest and optionally run `postUpdateCommand` |

`GET /api/projects` response includes `sshHost`, `sshUser`, and `editor` (`"vscode"|"cursor"|"zed"`) from the top-level config (all optional). Used by the web UI to render SSH deep-links for opening worktrees in the user's editor on the host machine.

`GET /api/projects` returns:

- `modelsByProvider`: the authoritative discovered models keyed by provider

Provider model discovery is owned by the provider contract via `listModels()`. `GET /api/projects` re-reads provider model availability when the response is built.

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

## WebSocket Endpoints

### Task Event Stream

```text
WS /api/tasks/:id/ws
```

Server messages match the shared type shape:

```typescript
type WsServerMessage =
  | { type: "connected" }
  | { type: "event"; data: unknown }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "status"; status: TaskStatus }
  | { type: "agent_status"; agentStatus: "idle" | "working" }
  | { type: "error"; message: string }
```

Client messages:

```typescript
type WsClientMessage =
  | { type: "prompt"; text: string; images?: PromptImage[] }
  | { type: "abort" }
```

### Terminal Stream

```text
WS /api/tasks/:id/terminal
```

This endpoint backs the dashboard terminal pane.

## Response Mapping

- DB task rows are normalized into camelCase API responses
- Timestamps are normalized before JSON responses
- Activity and system logs are exposed directly from SQLite-backed queries

## Error Semantics

- Validation failures return `400`
- Missing tasks/projects return `404`
- Non-terminal delete attempts return `409`
- Unhandled route errors are logged and return `500`

## Static Serving

If `web/dist` exists, the server serves it and falls back to `index.html` for SPA routes.
