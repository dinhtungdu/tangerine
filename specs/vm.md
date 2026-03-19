# VM Layer

Isolated execution environments. Per-project persistent VMs — no pool, no warm VMs, no idle reaping.

## Providers

| Provider | Platform | Use Case |
|----------|----------|----------|
| Lima | macOS | Local dev VMs via `limactl` |
| Incus | Linux | Local dev VMs via `incus` CLI |

v0: Lima only. Incus and cloud providers later.

## VM Lifecycle

```
provisioning → active → stopped → destroyed
                      → error
```

VMs are per-project and persistent. They survive task completion and server restarts. Tasks use git worktrees for isolation, not separate VMs.

### Statuses

| Status | Description |
|--------|-------------|
| `provisioning` | VM being created from golden image clone |
| `active` | VM running, available for tasks |
| `stopped` | VM stopped by user (can be restarted) |
| `destroyed` | VM permanently removed |
| `error` | VM not running (detected on startup reconciliation) |

## ProjectVmManager (`vm/project-vm.ts`)

Replaces the old `VMPoolManager`. One persistent VM per project.

### Key Methods

| Method | Description |
|--------|-------------|
| `getOrCreateVm(projectId, imageName)` | Get existing active VM or provision a new one |
| `getProjectVm(projectId)` | Get VM for project (null if none) |
| `stopVm(projectId)` | Stop a project's VM |
| `destroyVm(projectId)` | Destroy a project's VM permanently |
| `destroyVmById(vmId)` | Destroy a specific VM by ID |
| `listVms()` | List all non-destroyed VMs |
| `reconcileOnStartup()` | Verify active VMs are still alive on server start |

### Provisioning

1. Check for existing active/provisioning VM for the project
2. If none: insert `provisioning` record, clone from golden image, wait for SSH, mark `active`
3. If existing and `provisioning`: poll DB until it becomes `active`

VMs are created via `limactl clone` from the golden source VM (APFS copy-on-write, instant).

### Startup Reconciliation

`reconcileOnStartup()` runs on server start:
1. Query all VMs with status `active`
2. For each, check if provider reports it alive
3. Dead VMs marked as `error` with message `"VM not running on startup"`

## Git Worktrees

Tasks use `git worktree add` for isolation instead of full clones.

```
/workspace/
  repo/                          # Main repo clone (shared across tasks)
  worktrees/
    <task-id-prefix>/            # Per-task worktree (8-char prefix of task ID)
```

### Worktree Setup (in lifecycle.ts)

1. Ensure `/workspace/repo` exists: clone or `git fetch origin`
2. `git worktree add /workspace/worktrees/<prefix> -b tangerine/<prefix> origin/<defaultBranch>`
3. Run project setup in worktree directory
4. Start agent in worktree directory

### Worktree Cleanup (in cleanup.ts)

On task completion: `git worktree remove <path> --force` (falls back to `rm -rf`). VM persists.

## SSH Tunnels

Each OpenCode task establishes SSH tunnels from host to VM:

| Local Port | VM Port | Purpose |
|------------|---------|---------|
| Dynamic | 4096 | OpenCode server API |
| Dynamic | project.preview.port | Dev server preview |

Claude Code tasks don't use tunnels — they pipe stdin/stdout over SSH directly.

```typescript
interface SessionTunnel {
  vmIp: string
  sshPort: number
  agentPort: number      // local port → VM:4096
  previewPort: number    // local port → VM:preview.port
  process: Subprocess
}
```

Tunnels managed by `vm/tunnel.ts`. Ports allocated dynamically via `allocatePort()` (binds to port 0).

## DB Schema (VMs)

```sql
CREATE TABLE vms (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  ip TEXT,
  ssh_port INTEGER,
  status TEXT NOT NULL,        -- provisioning|active|stopped|destroyed|error
  project_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  region TEXT NOT NULL,
  plan TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT
);
```

No `task_id` column (VMs are per-project, not per-task). No `idle_since` (no pool reaping).

## Golden Image Build

See [project.md](./project.md#golden-images) for image definitions.

Two-layer build:
1. **Base layer** (`tangerine-base`): built from `tangerine.yaml` with cloud-init. All common tools. Slow (~10 min), rarely rebuilt.
2. **Project layer** (`tangerine-golden-<name>`): cloned from base, runs `build.sh`. Fast (~2-5 min).

`limactl clone` uses APFS `clonefile(2)` for instant, space-efficient copies.

### Base Packages (all images)

```
git, curl, wget, jq, build-essential, openssh-server,
opencode-ai, @anthropic-ai/claude-code, gh CLI, ripgrep, fd-find,
Node.js 22, Bun, Docker
```

Both `opencode-ai` and `@anthropic-ai/claude-code` are installed globally in the golden image so either provider can be used.
