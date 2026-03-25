# v1: Local Server Architecture

Tangerine runs inside a single VM alongside the agents. No SSH tunnels, no per-project VMs, no remote agent spawning. The VM is a sandbox — agents run with `--dangerously-skip-permissions` because the VM is disposable.

## Architecture

```
Host (laptop or VPS)
│
│  browser → localhost:3456 (forwarded)
│
└── Single VM (Lima locally, bare metal on VPS)
    ├── tangerine server (Hono on :3456)
    ├── tangerine web dashboard (served from dist/)
    ├── /workspace/project-a/repo       ← git clone
    │   └── worktrees/task-abc/         ← per-task worktree
    ├── /workspace/project-b/repo
    │   └── worktrees/task-def/
    ├── agents (claude, opencode)       ← local processes
    ├── Apache (preview on :80)         ← subdirectory sites
    └── MariaDB, PHP, tools             ← project deps
```

**Host responsibility**: boot the VM, forward port 3456, open browser. Nothing else.

**VM responsibility**: everything — server, dashboard, agents, repos, previews.

## What Changes from v0

### Removed entirely

| Component | Why |
|-----------|-----|
| `vm/project-vm.ts` (ProjectVmManager) | No per-project VMs. Single VM managed outside Tangerine |
| `vm/providers/` (Lima, Incus) | Tangerine doesn't manage VMs — it runs inside one |
| `vm/tunnel.ts` (SSH tunnels) | Everything is localhost. No tunnels |
| `vm/ssh.ts` (sshExec, waitForSsh) | Agents spawn locally, not via SSH |
| `vm/pool.ts` | Already deprecated |
| `image/build.ts` (golden image) | VM provisioned outside Tangerine (base-setup.sh) |
| `image/build-service.ts` | No build management |
| `image/tangerine.yaml` | Moves to deployment concern (Lima template) |
| Per-task tunnel lifecycle | All localhost — no tunnels to manage |
| Credential injection per-task | Credentials configured once in VM environment |
| Port allocation (`allocatePort`) | Preview uses subdirectories, not dynamic ports |
| `tasks/retry.ts` tunnel cleanup | No tunnels to clean up |

### Simplified

| Component | Before | After |
|-----------|--------|-------|
| Agent spawning | SSH into VM, spawn process | `Bun.spawn` locally |
| `AgentStartContext` | `vmIp`, `sshPort`, SSH tunnel | `workdir` only |
| Task lifecycle | 10+ steps (VM, SSH, tunnels, creds, clone, worktree, agent) | 4 steps (fetch, worktree, setup, agent) |
| Preview | Dynamic port + SSH -L tunnel + proxy | Subdirectory URL, direct reverse proxy to localhost Apache |
| Config | `image`, `previewCommand`, pool settings | `repo`, `setup`, `test`, `preview` (URL pattern) |
| DB schema | `vms` table, `vm_id` on tasks, `worktree_slots` with `vm_id` | `vms` table removed, `worktree_slots` simplified |
| Cleanup | Kill tunnels, SSH processes, agent via SSH | Kill local process |
| Reconciliation | Check Lima VMs alive, update SSH ports | Check agent processes alive |

### Stays the same

- Web dashboard (all of `web/`)
- API routes (Hono, REST + WebSocket)
- Agent provider abstraction (`AgentFactory`, `AgentHandle`, `AgentEvent`)
- NDJSON parser for Claude Code
- Task CRUD, status transitions
- Activity log, system log
- Session logs (chat history)
- GitHub integration (webhooks, polling)
- Worktree-based task isolation
- `useProjectNav`, project switching

## Config Schema

```typescript
// packages/shared/src/config.ts
const projectConfigSchema = z.object({
  name: z.string(),
  repo: z.string(),
  defaultBranch: z.string().default("main"),
  setup: z.string().optional(),           // runs in worktree after creation
  test: z.string().optional(),            // test command
  preview: z.object({                     // optional preview config
    baseUrl: z.string(),                  // e.g. "http://woo-next.test"
    provision: z.string().optional(),     // script to set up preview site
    teardown: z.string().optional(),      // script to tear down preview site
    urlPath: z.string().optional(),       // override: custom path pattern
  }).optional(),
  env: z.record(z.string()).optional(),   // extra env vars for agent
  model: z.string().optional(),
  defaultProvider: z.enum(["opencode", "claude-code"]).default("claude-code"),
})

const tangerineConfigSchema = z.object({
  projects: z.array(projectConfigSchema).min(1),
  model: z.string().default("anthropic/claude-sonnet-4-6"),
  models: z.array(z.string()).default([...]),
  integrations: integrationsSchema.optional(),
  workspace: z.string().default("/workspace"),  // base path for all repos
})
```

Example `config.json`:

```json
{
  "workspace": "/workspace",
  "projects": [
    {
      "name": "my-project",
      "repo": "git@github.com:org/my-project.git",
      "defaultBranch": "main",
      "setup": "npm install",
      "test": "npm test",
      "preview": {
        "baseUrl": "http://localhost:3000",
        "provision": "$HOME/worktree-scripts/provision.sh",
        "teardown": "$HOME/worktree-scripts/teardown.sh"
      },
      "defaultProvider": "claude-code"
    }
  ],
  "model": "anthropic/claude-sonnet-4-6"
}
```

## DB Schema Changes

### Remove

- `vms` table — no VM tracking
- `images` table — no image tracking
- `vm_id` column from `tasks` table
- `agent_port` column from `tasks` — agent is local, no port forwarding
- `preview_port` column from `tasks` — preview uses subdirectory URL
- `vm_id` column from `worktree_slots` — single machine, no VM reference

### Add

- `preview_url` column on `tasks` — the full preview URL for this task's site

### Modified `tasks` table

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,            -- manual, github, api
  source_id TEXT,
  source_url TEXT,
  repo_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  provider TEXT NOT NULL DEFAULT 'claude-code',
  model TEXT,
  reasoning_effort TEXT,
  branch TEXT,
  worktree_path TEXT,
  preview_url TEXT,                -- e.g. http://woo-next.test/task_abc/
  pr_url TEXT,
  user_id TEXT,
  agent_session_id TEXT,
  agent_pid INTEGER,              -- local process PID (replaces agent_port)
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);
```

### Modified `worktree_slots` table

```sql
CREATE TABLE IF NOT EXISTS worktree_slots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,       -- replaces vm_id
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
```

## Task Lifecycle (New)

### States

Same as v0: `created → provisioning → running → done/failed/cancelled`

### Flow: `startSession(task, config)`

```
1. FETCH REPO
   cd /workspace/{project}/repo && git fetch origin
   (repo was cloned during project setup — see Deployment)

2. CREATE WORKTREE
   Acquire slot from worktree pool (or create new)
   git worktree add {slot_path} -b tangerine/{task_prefix} origin/{defaultBranch}

3. RUN SETUP (background, non-blocking)
   cd {worktree_path} && {config.setup}
   Track status via /tmp/tangerine-setup-{prefix}.status

4. START AGENT (immediate, parallel with setup)
   Bun.spawn: claude --output-format stream-json --input-format stream-json
              --verbose --dangerously-skip-permissions
   cwd: {worktree_path}
   env: { ...process.env, ...config.env }

5. PROVISION PREVIEW (if configured, after setup completes)
   cd {worktree_path} && bash {config.preview.provision}
   Store preview_url on task
```

That's it. No VM acquisition, no SSH, no tunnels, no credential injection, no port allocation.

### Flow: `cleanupSession(task)`

```
1. Kill agent process (agent_pid)
2. Run preview teardown (if configured):
   cd {worktree_path} && bash {config.preview.teardown}
3. Remove worktree:
   git worktree remove {worktree_path}
4. Release worktree slot
5. Delete branch (if no PR):
   git branch -D tangerine/{task_prefix}
```

### Flow: reconnect on server restart

```
For each task with status 'running':
  1. Check if agent_pid is still alive (kill -0)
  2. If alive: resubscribe to stdout stream
  3. If dead: restart agent with --resume {session_id}
```

## Agent Provider Changes

### `AgentStartContext` (simplified)

```typescript
interface AgentStartContext {
  taskId: string
  workdir: string              // absolute path to worktree
  title: string
  model?: string
  reasoningEffort?: string
  resumeSessionId?: string
  env?: Record<string, string> // extra env vars
}
```

Removed: `vmIp`, `sshPort` (no SSH), `setupCommand` (handled by lifecycle).

### Claude Code Provider (simplified)

Before: SSH into VM, spawn claude via SSH command, parse stdout over SSH pipe.

After: `Bun.spawn(["claude", ...args], { cwd: workdir, stdin: "pipe", stdout: "pipe" })`. Direct local process. The NDJSON parser stays the same — it reads from `proc.stdout`.

```typescript
// agent/claude-code-provider.ts
start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
  const args = [
    "claude",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ]
  if (ctx.model) args.push("--model", ctx.model)
  if (ctx.resumeSessionId) args.push("--resume", ctx.resumeSessionId)

  const proc = Bun.spawn(args, {
    cwd: ctx.workdir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...ctx.env },
  })
  // ... rest is same NDJSON parsing logic
}
```

### OpenCode Provider (simplified)

Before: SSH into VM, start `opencode serve`, create SSH -L tunnel for HTTP port, poll SSE events via tunnel.

After: `Bun.spawn(["opencode", "serve"], { cwd: workdir })`. Connect to localhost port directly.

## Preview System

### Subdirectory model (WordPress projects)

All preview sites live under one Apache vhost as subdirectories:

```
http://woo-next.test/task_abc123/          ← task A
http://woo-next.test/task_def456/          ← task B
http://woo-next.test/task_def456/wp-admin  ← admin
```

One Apache instance, one port (80), one domain. Each task's provision script creates:
- WordPress install at `$HOME/Sites/woo-next/{sanitized_name}/`
- Database `{sanitized_name}`
- Symlinks to worktree plugins/themes

The preview URL is stored on the task: `preview_url = http://woo-next.test/{sanitized_name}/`

### Non-WordPress projects

For projects with a dev server (e.g. Node apps), the preview config supports a `command` approach:

```json
{
  "preview": {
    "command": "npm run dev -- --port $PORT",
    "baseUrl": "http://localhost"
  }
}
```

Tangerine allocates a port and starts the dev server. The preview URL becomes `http://localhost:{port}/`. This is the simpler case — no subdirectory routing needed.

### Dashboard preview access

The dashboard accesses previews by URL. For local VMs, the host needs port 80 forwarded (Lima does this). For VPS, the preview domain resolves to the server.

The dashboard embeds an iframe or shows a link:
```
Preview: http://woo-next.test/task_abc123/
```

## Worktree Pool (Simplified)

Same concept, no `vm_id`:

```typescript
// Pre-warm N worktree slots per project
function initPool(db: Database, projectId: string, repoPath: string, poolSize: number)

// Acquire a slot for a task
function acquireSlot(db: Database, projectId: string, taskId: string): { path: string; branch: string }

// Release a slot back to the pool
function releaseSlot(db: Database, slotId: string)
```

Slots are created by running `git worktree add` locally. No SSH.

## Deployment

Tangerine itself doesn't manage VMs. Deployment is external.

### Local (Lima on macOS)

```bash
# One-time setup
limactl start --name tangerine tangerine.yaml   # minimal VM
limactl shell tangerine                          # SSH into VM
bash /path/to/base-setup.sh                      # install tools
tangerine init                                   # interactive project setup
tangerine start                                  # start server

# Daily use
limactl shell tangerine
tangerine start
# Open browser: http://localhost:3456
```

The Lima template (`tangerine.yaml`) is minimal — just the VM config with `portForwards` for 3456 and 80. Tool installation happens via `base-setup.sh` (run once after VM creation).

Port forwarding:
- `:3456` → dashboard + API
- `:80` → Apache preview sites
- Disable all auto port-forwarding (guestIP ignore rules)

### VPS / Remote

```bash
# SSH into VPS
ssh user@vps
bash /path/to/base-setup.sh
tangerine init
tangerine start
# Access via http://vps-ip:3456 or Tailscale hostname
```

No Lima. Tangerine runs directly on the machine. Preview accessible at `http://vps-ip/` or via Tailscale.

### GHE Access (one-time setup)

For GitHub Enterprise behind a proxy:

```bash
# On the VM (or in base-setup.sh):

# 1. Git credentials
git config --global credential.helper store
echo "https://x-access-token:$GHE_TOKEN@github.example.com" > ~/.git-credentials

# 2. SOCKS proxy (if needed — reverse tunnel from host)
# On host: ssh -fN -R 127.0.0.2:8080:127.0.0.1:8080 user@vm
git config --global http.https://github.example.com/.proxy socks5://127.0.0.2:8080
git config --global url."https://github.example.com/".insteadOf "git@github.example.com:"

# 3. gh CLI
export HTTPS_PROXY=socks5://127.0.0.2:8080
export GH_HOST=github.example.com
```

This is a deployment concern, not a Tangerine feature. Tangerine just does `git clone` and it works.

## File Structure (After)

```
packages/
  shared/src/
    types.ts         # TaskStatus, ProviderType, AgentEvent, WsMessage
    config.ts        # ProjectConfig, TangerineConfig (simplified)
    constants.ts     # Default port, timeouts
  server/src/
    api/             # Hono routes (mostly unchanged)
      routes/
        tasks.ts     # Task CRUD
        sessions.ts  # Agent communication (prompt, abort)
        system.ts    # Logs, config, orphan cleanup (remove VM endpoints)
        preview.ts   # Reverse proxy to preview URL
        ws.ts        # WebSocket bridge
        terminal-ws.ts
        project.ts   # Project CRUD
    agent/           # Agent providers (simplified — local spawn)
      provider.ts    # AgentFactory, AgentHandle interfaces
      claude-code-provider.ts  # Local Bun.spawn
      opencode-provider.ts     # Local Bun.spawn
      ndjson.ts      # NDJSON parser (unchanged)
      prompt-queue.ts
    tasks/           # Task lifecycle (simplified)
      manager.ts     # createTask, cancelTask, completeTask
      lifecycle.ts   # startSession (4 steps), cleanupSession
      worktree-pool.ts  # Worktree slot management (no vm_id)
      cleanup.ts     # Kill process, teardown preview, remove worktree
      retry.ts       # Retry with cleanup (simplified — no tunnel cleanup)
      events.ts      # Task event bus
      health.ts      # Process health check (kill -0)
    db/              # SQLite (simplified schema)
    integrations/    # GitHub webhooks + polling (unchanged)
    cli/             # CLI commands
      start.ts       # Start server (simplified — no VM layer)
      project.ts     # Project management
    config.ts        # Config loading
    logger.ts
    system-log.ts
    activity.ts
    errors.ts
web/                 # Dashboard (mostly unchanged)
  src/
    components/
      StatusWidgets.tsx  # Remove ImageCard, simplify VmSummaryCard
    pages/
      StatusPage.tsx     # Simplified — no image build, no VM provision
deploy/              # Deployment scripts (NEW — extracted from server)
  tangerine.yaml     # Lima VM template (minimal)
  base-setup.sh      # Common tool installation
  images/            # Per-project build scripts
    my-project/
      build.sh
      provision.sh
```

## Migration Checklist

### Phase 1: Extract VM layer

1. Move `image/tangerine.yaml` → `deploy/tangerine.yaml`
2. Move `image/base-setup.sh` → `deploy/base-setup.sh`
3. Delete `vm/` directory (providers, project-vm, tunnel, ssh, pool)
4. Delete `image/build.ts`, `image/build-service.ts`

### Phase 2: Simplify agent providers

5. Remove `vmIp`, `sshPort` from `AgentStartContext`
6. Claude Code provider: replace SSH spawn with `Bun.spawn`
7. OpenCode provider: replace SSH spawn + tunnel with local `Bun.spawn`
8. Remove SSH-related imports from providers

### Phase 3: Simplify task lifecycle

9. Remove VM acquisition step from `startSession`
10. Remove tunnel creation steps (proxy, API, preview)
11. Remove credential injection steps
12. `git fetch` instead of clone (repo pre-cloned during deployment)
13. Worktree pool: remove `vm_id`, use `project_id`
14. Cleanup: kill local PID instead of SSH-based cleanup
15. Reconnect: check PID alive instead of SSH + tunnel recreation

### Phase 4: Simplify API + dashboard

16. Remove `/api/vms/*` endpoints (provision, destroy, rebuild)
17. Remove `/api/images/*` endpoints (build-base, build-status)
18. Remove `ImageCard`, simplify `VmSummaryCard` → project health card
19. Preview route: proxy to localhost URL instead of SSH tunnel
20. Remove `StatusPage` VM/image management

### Phase 5: Update config + DB

21. Simplify config schema (remove `image`, `pool`, `previewCommand`)
22. Add `preview.baseUrl`, `preview.provision`, `preview.teardown`
23. DB migration: drop `vms`, `images` tables
24. DB migration: remove `vm_id`, `agent_port`, `preview_port` from tasks
25. DB migration: add `preview_url`, `agent_pid` to tasks
26. DB migration: worktree_slots `vm_id` → `project_id`

### Phase 6: Deployment tooling

27. Create `deploy/tangerine.yaml` (Lima template — minimal, just VM config)
28. Create `deploy/base-setup.sh` (installs Node, git, gh, pnpm, php, etc.)
29. Update `tangerine init` to work inside VM (no VM creation — just project setup)
30. Update `tangerine start` to run server directly (no VM boot)
31. Document deployment for Lima (local) and VPS (remote)
