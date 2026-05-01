# Cross-Project Task Creation

Agents can create tasks in other projects. Preserves context that would be lost with manual creation.

## Problem

Agent working on Project A discovers issue in Project B. Agent has full context (code, errors, reasoning). Switching to manually create the task loses that context.

## Design

### Communication Path

```
Agent (Project A) → Tangerine API → provisions task → Agent (Project B)
```

Agent never talks to Project B's agent directly. Server is the coordinator — same as web dashboard or API.

### API Access

The server listens on `DEFAULT_API_PORT = 3456`. Agents access it at `http://127.0.0.1:3456`.

### CLI: `tangerine-task`

Lightweight shell script or binary installed on the machine. Talks to `http://127.0.0.1:3456`.

#### Commands

```bash
# List available projects
tangerine-task projects
# → wordpress-develop
# → tangerine
# → gutenberg

# Create task in another project
tangerine-task create \
  --project "wordpress-develop" \
  --title "Fix N+1 query in post loader" \
  --description "Found while working on tangerine task abc123. The post loader at src/loaders/post.ts:42 fires a separate query per author. Should batch with IN clause."

# Create with configured agent override
tangerine-task create \
  --project "gutenberg" \
  --title "Update block editor API" \
  --provider pi
```

#### Auto-Attached Metadata

Every task created via CLI auto-attaches:
- `source: "cross-project"` — new source type (alongside github, linear, manual)
- `source_id: "<origin-task-id>"` — the task that spawned it (read from `$TANGERINE_TASK_ID` env var)
- Description footer: `\n\n---\nCreated from task <origin-task-id> in project <origin-project>`

`TANGERINE_TASK_ID` is injected as an env var during session setup (alongside credentials).

#### Output

```bash
# Success
✓ Task created: <task-id> in project wordpress-develop

# Error
✗ Project "foo" not found. Available: wordpress-develop, tangerine, gutenberg
✗ Server unreachable (is the tunnel up?)
```

### Server Changes

#### New API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all configured projects (name, repo) |

`POST /api/tasks` already exists. Add `source: "cross-project"` as valid source.

#### Task Source

Add `"cross-project"` to the `source` enum:

```
github | linear | manual | cross-project
```

No schema migration needed — `source` is TEXT. Just update validation.

### Session Setup Changes

In `startSession` and `reconnectSession`:

1. Inject `TANGERINE_TASK_ID=<task.id>` and `TANGERINE_SERVER_PORT=3456` as env vars
2. If configured, also inject `TANGERINE_AUTH_TOKEN=<shared bearer token>`

### Agent Environment

Agents receive env vars for API access:
- `TANGERINE_TASK_ID` — current task ID
- `TANGERINE_SERVER_PORT` — API port (default 3456)
- `TANGERINE_AUTH_TOKEN` — bearer token when configured

The `tangerine-task` CLI script (~30 lines) wraps these calls:
- `projects`: `curl -s http://127.0.0.1:$TANGERINE_SERVER_PORT/api/projects | jq -r '.[].name'`
- `create`: builds JSON payload, `curl -X POST http://127.0.0.1:$TANGERINE_SERVER_PORT/api/tasks`

## Implementation Order

1. Add `GET /api/projects` endpoint
2. Add `"cross-project"` as valid task source
3. Inject `TANGERINE_TASK_ID` + `TANGERINE_SERVER_PORT` env vars
4. Write `tangerine-task` shell script
5. Tests: API route test for `/api/projects`

## Not In Scope (future)

- Task linking (blocked-by, related-to relationships)
- Per-user auth or scoped tokens
- Web dashboard UI for cross-project task lineage
- Bidirectional context sharing (attaching files/diffs from origin task)
