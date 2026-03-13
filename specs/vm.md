# VM Layer

Isolated execution environments. Reuses hal9999's provider interface, pool management, and SSH layer.

## Providers

| Provider | Platform | Use Case |
|----------|----------|----------|
| Lima | macOS | Local dev VMs via `limactl` |
| Incus | Linux | Local dev VMs via `incus` CLI |

v0: Lima only. Incus and cloud providers later.

## VM Lifecycle

```
provision → ready → assigned (to session) → released → ready (warm pool)
                                                      → destroyed (idle timeout)
```

### Provisioning

From hal9999:
- `Provider.createInstance()` — spin up from golden image snapshot
- `Provider.waitForReady()` — wait until VM is accessible
- `waitForSsh()` — verify SSH connectivity

### Warm Pool

Reuse hal9999's `VMPoolManager`:
- `minReady` — keep N warm VMs ready
- `acquireVm(taskId)` — grab a warm VM or provision new one
- `releaseVm(vmId)` — return to pool, clean workspace
- `reapIdleVms()` — destroy after idle timeout
- Per-provider idle timeouts

Pool serves one project's image at a time (v0).

### VM Cleanup on Release

When a session ends and VM returns to pool:
1. Kill OpenCode server
2. Kill dev server / Docker containers
3. `rm -rf /workspace/*`
4. Scrub credentials from env
5. Mark as `ready` in pool

## SSH Tunnels

Each active session establishes SSH tunnels from host to VM:

| Local Port | VM Port | Purpose |
|------------|---------|---------|
| Dynamic | 4096 | OpenCode server API |
| Dynamic | project.preview.port | Dev server preview |

Tunnels managed by the API server. Allocated dynamically to avoid conflicts across concurrent sessions.

```typescript
interface SessionTunnel {
  vmIp: string;
  sshPort?: number;
  opencodePort: number;    // local port → VM:4096
  previewPort: number;     // local port → VM:preview.port
  process: ChildProcess;   // SSH tunnel process
}
```

### Tunnel Setup

```bash
ssh -N -L <localOpencode>:127.0.0.1:4096 \
       -L <localPreview>:127.0.0.1:<previewPort> \
       agent@<vm-ip> -p <ssh-port>
```

### Tunnel Health

API server monitors tunnel processes. If tunnel dies, attempt reconnect. If VM is dead, fail the session.

## DB Schema (VMs)

Reuse hal9999's `VmRow`:

```sql
CREATE TABLE vms (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  ip TEXT,
  ssh_port INTEGER,
  status TEXT NOT NULL,        -- provisioning|ready|assigned|destroying|destroyed|error
  task_id TEXT,                -- session using this VM
  snapshot_id TEXT NOT NULL,   -- golden image
  region TEXT NOT NULL,
  plan TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  idle_since TEXT
);
```

## Golden Image Build

See [project.md](./project.md#golden-images) for image definitions.

Build process (from hal9999):
1. `tangerine image build` (reads `tangerine/build.sh` from project dir)
2. Provision base VM (Debian 13)
3. Run project's `build.sh` (installs everything)
4. Create snapshot (named after `project.image` in `.tangerine/config.json`)
5. Future VMs clone from snapshot

### Base Packages (all images)

```
git, curl, wget, jq, build-essential, openssh-server,
opencode (pre-installed), gh CLI, ripgrep, fd-find
```
