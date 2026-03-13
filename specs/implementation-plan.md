# Implementation Plan

Phased build plan for Tangerine v0. Solo dev, local-first, targeting macOS M4 Max with 5 concurrent VMs.

## Workspace Setup

Bun workspaces with shared types between API server and web dashboard.

### Root `package.json`

```json
{
  "name": "tangerine",
  "private": true,
  "workspaces": ["packages/*", "web"],
  "scripts": {
    "dev": "bun run --filter '*' dev",
    "dev:api": "bun run --filter tangerine-server dev",
    "dev:web": "bun run --filter tangerine-web dev",
    "check": "bun run --filter '*' check",
    "test": "bun run --filter '*' test"
  }
}
```

### Package Layout

```
packages/
  shared/              # @tangerine/shared — types, constants, config schema
    src/
      types.ts         # TaskStatus, VmStatus, WsMessage, etc.
      config.ts        # ProjectConfig, TangerineConfig Zod schemas
      constants.ts     # Status values, default ports, timeouts
    package.json       # name: "@tangerine/shared"
  server/              # tangerine-server — Hono API + VM + Agent
    src/
      api/             # Hono routes
      vm/              # Lima provider, pool, SSH
      agent/           # OpenCode SDK bridge
      tasks/           # Task lifecycle
      integrations/    # GitHub polling
      db/              # SQLite schema + queries
      image/           # Golden image templates + build
      types.ts         # Server-internal types
      index.ts         # Entry point
    package.json
web/                   # tangerine-web — Vite + React
  src/
    ...
  package.json         # name: "tangerine-web"
```

### Shared Types (`@tangerine/shared`)

Core types consumed by both server and web:

- `TaskStatus`: `"created" | "provisioning" | "running" | "done" | "failed" | "cancelled"`
- `VmStatus`: `"provisioning" | "ready" | "assigned" | "destroying" | "destroyed" | "error"`
- `Task`: full task object shape (matches DB row, serialized for API)
- `WsServerMessage`: `{ type: "event" | "status" | "error" | "connected"; ... }`
- `WsClientMessage`: `{ type: "prompt" | "abort"; ... }`
- `ProjectConfig`: Zod schema for `.tangerine/config.json`
- `PoolStats`: pool status shape

---

## Phase 0: OpenCode SDK Spike

**Goal**: Validate that we can programmatically control OpenCode server mode — create sessions, send prompts, stream events, abort.

**Dependencies**: None. This is the first thing to build.

**What to build**:

| File | Description |
|------|-------------|
| `spike/opencode-spike.ts` | Standalone script, no project scaffolding needed |

**Steps**:

1. Install OpenCode locally if not present
2. Start `opencode serve --port 4096` in a test directory with a real repo
3. Write `spike/opencode-spike.ts`:
   - Install `@opencode-ai/sdk` as a dev dep at root
   - Connect with `createOpencodeClient({ baseUrl: "http://localhost:4096" })`
   - Call `client.global.health()` — verify connection
   - Call `client.session.create({ body: { title: "spike test" } })` — get session ID
   - Call `client.session.prompt_async(...)` with a simple prompt
   - Subscribe to `client.event.subscribe()` — iterate SSE stream, log each event
   - Wait for completion event, then call `client.session.messages(...)` — verify history
   - Call `client.session.abort(...)` during a long prompt — verify it stops
   - Call `client.session.diff(...)` — verify diff retrieval
4. Document event types received, latencies, error modes

**Acceptance criteria**:
- [ ] Can connect to OpenCode server and get healthy response
- [ ] Can create a session and send a prompt
- [ ] Can stream SSE events and see assistant tokens arrive in real time
- [ ] Can retrieve message history after completion
- [ ] Can abort a running prompt
- [ ] Can retrieve file diffs
- [ ] Event type taxonomy is documented

**Complexity**: S

---

## Phase 1: Foundation

**Goal**: Project scaffolding, DB, config loading, extract VM layer from hal9999. After this phase, we can provision and manage VMs programmatically.

**Dependencies**: Phase 0 completed (SDK validated).

### 1a. Project Scaffolding

**Complexity**: S

| File | Description |
|------|-------------|
| `package.json` | Root workspace config |
| `packages/shared/package.json` | Shared types package |
| `packages/shared/src/types.ts` | TaskStatus, VmStatus, WsMessage types |
| `packages/shared/src/config.ts` | ProjectConfig + TangerineConfig Zod schemas |
| `packages/shared/src/constants.ts` | Default ports, timeouts, status enums |
| `packages/shared/src/index.ts` | Re-exports |
| `packages/server/package.json` | Server package (hono, bun:sqlite deps) |
| `packages/server/src/index.ts` | Entry point (placeholder) |
| `packages/server/tsconfig.json` | TS config |
| `web/package.json` | Vite + React package |
| `web/vite.config.ts` | Vite config with API proxy |
| `web/src/main.tsx` | React entry |
| `web/src/App.tsx` | Placeholder app |
| `tsconfig.json` | Root TS config |

**Acceptance criteria**:
- [ ] `bun install` succeeds at root
- [ ] `bun run check` runs type-check across all packages
- [ ] Server can import from `@tangerine/shared`
- [ ] Web can import from `@tangerine/shared`
- [ ] `bun run dev:api` starts
- [ ] `bun run dev:web` starts Vite dev server

### 1b. Database Layer

**Complexity**: S

| File | Description |
|------|-------------|
| `packages/server/src/db/index.ts` | `getDb()`, schema init — adapted from hal9999 |
| `packages/server/src/db/schema.ts` | SQL schema strings (vms, tasks, images, session_logs) |
| `packages/server/src/db/queries.ts` | Typed query functions |
| `packages/server/src/db/types.ts` | DB row types |
| `packages/server/src/db/__tests__/db.test.ts` | Tests with in-memory SQLite |

Schema changes from hal9999:
- `tasks` table: add `source`, `source_id`, `source_url`, `description`, `user_id`, `opencode_session_id`, `opencode_port`, `preview_port`, `title`, `error` columns
- `vms` table: same as hal9999
- New `session_logs` table:
  ```sql
  CREATE TABLE session_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
  ```

**Acceptance criteria**:
- [ ] DB creates tables on first run
- [ ] CRUD operations for tasks and VMs work with typed queries
- [ ] Tests pass with in-memory DB
- [ ] Migrations run idempotently

### 1c. Config Loading

**Complexity**: S

| File | Description |
|------|-------------|
| `packages/server/src/config.ts` | Load + validate `.tangerine/config.json` and env vars |
| `packages/shared/src/config.ts` | Zod schemas for project config |

Loads from:
1. `./tangerine.json` (project-specific)
2. `~/.config/tangerine/config.json` (global defaults)
3. Environment variables (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GH_HOST`)

Model configuration: global default + per-project override.

**Acceptance criteria**:
- [ ] Loads and validates config from both paths
- [ ] Environment variables override config file values
- [ ] Missing required fields throw clear errors

### 1d. VM Layer (Extract from hal9999)

**Complexity**: M

| File | Source (hal9999) | Changes |
|------|-----------------|---------|
| `packages/server/src/vm/providers/types.ts` | `src/providers/types.ts` | Same Provider interface |
| `packages/server/src/vm/providers/lima.ts` | `src/providers/lima.ts` | Change label prefix to `tangerine` |
| `packages/server/src/vm/pool.ts` | `src/pool/manager.ts` | Update task status names, label prefix |
| `packages/server/src/vm/pool-types.ts` | `src/pool/types.ts` | Same interfaces |
| `packages/server/src/vm/ssh.ts` | `src/ssh.ts` | Remove picocolors |
| `packages/server/src/vm/tunnel.ts` | New | SSH tunnel manager with dynamic port allocation |
| `packages/server/src/vm/__tests__/pool.test.ts` | New | Pool tests with mock provider |

**Tunnel Manager** (`tunnel.ts`):
```typescript
interface SessionTunnel {
  vmIp: string;
  sshPort?: number;
  opencodePort: number;    // local port → VM:4096
  previewPort: number;     // local port → VM:<preview.port>
  process: ChildProcess;
}
```

**Acceptance criteria**:
- [ ] LimaProvider can create, list, and destroy VMs
- [ ] Pool manager acquires, releases, and reaps VMs correctly
- [ ] SSH exec works against a running Lima VM
- [ ] Tunnel manager creates SSH tunnels with unique ports
- [ ] All hal9999 references removed

---

## Phase 2: VM + Agent Wiring

**Goal**: End-to-end: acquire VM, clone repo, start OpenCode, tunnel, send prompt, stream response.

**Dependencies**: Phase 1 complete.

### 2a. Golden Image

**Complexity**: S

| File | Description |
|------|-------------|
| `packages/server/src/image/tangerine.yaml` | Lima VM template — 4 CPU, 8 GiB RAM, 20 GiB disk |
| `packages/server/src/image/build.ts` | Image build: create VM from template, snapshot |
| `images/node-dev/build.sh` | Node.js baseline image |
| `images/wordpress-dev/build.sh` | WordPress: Docker, wp-env, PHP, Composer |

Base packages: git, curl, wget, jq, build-essential, openssh-server, opencode, gh CLI, ripgrep, fd-find, Node.js 22, Bun, Docker.

**Acceptance criteria**:
- [ ] `bun run packages/server/src/image/build.ts node-dev` builds and snapshots
- [ ] Cloned VMs have all tools available
- [ ] SSH as `agent` works, `/workspace` exists

### 2b. Session Lifecycle

**Complexity**: L

| File | Description |
|------|-------------|
| `packages/server/src/tasks/lifecycle.ts` | Acquire VM → clone → branch → setup → OpenCode → tunnel → running |
| `packages/server/src/tasks/cleanup.ts` | Pull logs → kill processes → scrub creds → release VM |
| `packages/server/src/tasks/manager.ts` | TaskManager: create, start, cancel, complete. Queue management |

**Session start flow**:
1. `created` → `provisioning`
2. Acquire VM from pool
3. Wait for SSH
4. Inject credentials (ANTHROPIC_API_KEY, GITHUB_TOKEN, git-credentials)
5. Clone repo, create branch `tangerine/<task-short-id>`
6. Run project setup
7. Start `opencode serve --port 4096 --hostname 0.0.0.0`
8. Create SSH tunnels
9. Wait for OpenCode health
10. Create OpenCode session, send initial prompt with task description
11. `provisioning` → `running`

**Session cleanup flow**:
1. Pull messages via SDK → store in `session_logs`
2. Kill OpenCode + dev server
3. Scrub credentials
4. Clean workspace
5. Destroy tunnels
6. Release VM to pool

**Acceptance criteria**:
- [ ] Full lifecycle: created → provisioning → running
- [ ] OpenCode reachable via tunnel
- [ ] Can send prompt and receive response through SDK
- [ ] Cleanup kills processes, returns VM to pool
- [ ] Session messages persisted before cleanup

### 2c. OpenCode SDK Bridge

**Complexity**: M

| File | Description |
|------|-------------|
| `packages/server/src/agent/client.ts` | Per-task OpenCode client instances |
| `packages/server/src/agent/events.ts` | SSE subscription: subscribe, reconnect, filter |
| `packages/server/src/agent/prompt-queue.ts` | Queue prompts while agent is busy |
| `packages/server/src/agent/types.ts` | Event type mappings, completion detection |

**Prompt Queue**: per-task queue, sends next on agent idle, tracks `idle | working` state from SSE events.

**Acceptance criteria**:
- [ ] Client connects to tunneled OpenCode server
- [ ] SSE events stream and parse correctly
- [ ] Prompt queue delivers sequentially
- [ ] Completion detection works
- [ ] SSE reconnection on disconnect
- [ ] Abort stops execution

---

## Phase 3: API + Real-time

**Goal**: Full HTTP API, WebSocket relay, preview proxy, GitHub polling.

**Dependencies**: Phase 2 complete.

### 3a. REST API

**Complexity**: M

| File | Description |
|------|-------------|
| `packages/server/src/api/app.ts` | Hono app, middleware |
| `packages/server/src/api/routes/tasks.ts` | Task CRUD + cancel + done |
| `packages/server/src/api/routes/sessions.ts` | Messages, prompt, abort, diff |
| `packages/server/src/api/routes/project.ts` | Project config |
| `packages/server/src/api/routes/system.ts` | Health, pool status |
| `packages/server/src/api/middleware/error.ts` | Error handler |
| `packages/server/src/index.ts` | Wire + start |

**Acceptance criteria**:
- [ ] All endpoints from specs/api.md implemented
- [ ] Typed responses
- [ ] Prompt endpoint queues via prompt queue
- [ ] Structured error responses

### 3b. WebSocket Relay

**Complexity**: M

| File | Description |
|------|-------------|
| `packages/server/src/api/routes/ws.ts` | WS upgrade at `/api/tasks/:id/ws` |
| `packages/server/src/api/ws-manager.ts` | Track clients per task, broadcast |

**Flow**: WS connects → `connected` ack → SSE events relayed as `{ type: "event", data }` → client sends `{ type: "prompt" }` or `{ type: "abort" }`.

**Acceptance criteria**:
- [ ] Agent events relayed to all connected WS clients
- [ ] Prompt/abort via WS works
- [ ] Disconnected clients cleaned up

### 3c. Preview Proxy

**Complexity**: S

| File | Description |
|------|-------------|
| `packages/server/src/api/routes/preview.ts` | Reverse proxy at `/preview/:id/*` |

**Acceptance criteria**:
- [ ] Proxies to VM dev server via tunnel
- [ ] Static assets + WebSocket (HMR) work

### 3d. GitHub Polling

**Complexity**: M

| File | Description |
|------|-------------|
| `packages/server/src/integrations/github.ts` | Poll GitHub API for assigned issues |
| `packages/server/src/integrations/poller.ts` | Generic polling loop |

Polls `GET /repos/:owner/:repo/issues?assignee=<user>&state=open` every 60 minutes. Deduplicates on `source_id`.

**Acceptance criteria**:
- [ ] New matching issues create tasks
- [ ] No duplicates
- [ ] Handles API errors gracefully
- [ ] Stops cleanly on shutdown

---

## Phase 4: Web Dashboard

**Goal**: Functional React UI for monitoring, chatting, previewing, diffing.

**Dependencies**: Phase 3 complete.

### 4a. Foundation + Task List

**Complexity**: M

| File | Description |
|------|-------------|
| `web/src/lib/api.ts` | Typed REST client |
| `web/src/hooks/useTasks.ts` | Fetch + poll task list |
| `web/src/components/Layout.tsx` | App shell, dark theme |
| `web/src/components/TaskList.tsx` | Filterable task list |
| `web/src/components/TaskCard.tsx` | Task row |
| `web/src/components/StatusBadge.tsx` | Status indicator |
| `web/src/pages/Dashboard.tsx` | Dashboard page |

**Acceptance criteria**:
- [ ] Task list with 5s polling
- [ ] Status filter
- [ ] Click navigates to detail
- [ ] Dark theme

### 4b. Chat UI

**Complexity**: L

| File | Description |
|------|-------------|
| `web/src/hooks/useWebSocket.ts` | WS with auto-reconnect |
| `web/src/hooks/useSession.ts` | Messages, agent status, queue |
| `web/src/pages/TaskDetail.tsx` | Split view |
| `web/src/components/ChatPanel.tsx` | Messages + input + abort |
| `web/src/components/ChatMessage.tsx` | User/agent message |
| `web/src/components/ToolCallDisplay.tsx` | File edits, shell output |
| `web/src/components/ChatInput.tsx` | Input + queue indicator |

**Acceptance criteria**:
- [ ] Streaming tokens in real time
- [ ] Tool call rendering
- [ ] Abort button
- [ ] Queue indicator
- [ ] Auto-scroll
- [ ] Markdown rendering

### 4c. Preview + Diff + Info

**Complexity**: M

| File | Description |
|------|-------------|
| `web/src/components/PreviewPanel.tsx` | iframe + controls |
| `web/src/components/DiffView.tsx` | Syntax-highlighted diff |
| `web/src/components/InfoPanel.tsx` | Task metadata |
| `web/src/components/TabPanel.tsx` | Tab container |

**Acceptance criteria**:
- [ ] Preview loads in iframe
- [ ] Diff renders with highlighting
- [ ] Info shows all metadata
- [ ] Resizable split

---

## Phase 5: Polish

**Goal**: Error recovery, pool tuning, CLI, docs.

**Dependencies**: Phase 4 complete.

### 5a. Error Recovery + Retry

**Complexity**: M

| File | Description |
|------|-------------|
| `packages/server/src/tasks/retry.ts` | Auto-retry on VM failure (up to 3x) |
| `packages/server/src/tasks/health.ts` | Periodic health checks (30s) |

**Acceptance criteria**:
- [ ] VM failure triggers retry up to N times
- [ ] Tunnel reconnection on transient SSH failure
- [ ] Unrecoverable failures surface to user via WS

### 5b. Warm Pool Tuning

**Complexity**: S

Config for M4 Max 48GB: `minReady: 2`, `maxPoolSize: 5`, `idleTimeoutMs: 600_000`, VM spec: 4 CPU, 8 GiB RAM, 20 GiB disk.

### 5c. CLI

**Complexity**: M

| Command | Description |
|---------|-------------|
| `tangerine start` | Start API + dashboard + pool + poller |
| `tangerine image build <name>` | Build golden image |
| `tangerine image list` | List images |
| `tangerine task create --repo --title --description` | Manual task |
| `tangerine pool status` | Pool info |
| `tangerine pool reconcile` | Force reconcile |

### 5d. Logging

**Complexity**: S

Structured logger (JSON prod, pretty dev). Log task lifecycle, VM provisioning, SSH/tunnel events, SDK events, API requests.

---

## Critical Path

```
Spike → DB + VM extract → Session lifecycle → WebSocket relay → Chat UI
```

Everything else parallelizable. GitHub polling can follow manual task creation. Preview proxy can follow chat.

## Testing Strategy

- **Unit**: DB queries, prompt queue, config parsing, pool logic (mock provider)
- **Integration**: Session lifecycle against real Lima VMs (manual)
- **E2E**: Full flow manual testing — create task, chat, preview, diff
