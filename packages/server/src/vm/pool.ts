// VM warm pool: pre-provisions VMs from golden image snapshots.
// Logs acquisition, release, and reaping so pool behavior is auditable.

import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createLogger } from "../logger"
import { waitForSsh } from "./ssh"
/** VmRow for standalone pool functions (camelCase, not the DB snake_case VmRow) */
interface PoolVmRow {
  id: string
  status: string
  taskId: string | null
  idleSince: string | null
  [key: string]: unknown
}
import type { PoolConfig, ProviderSlot } from "./pool-types"

const log = createLogger("pool")

// --- Standalone function API (used by tracer-pool-lifecycle tests) ---

export interface PoolDeps {
  provisionVm(snapshotId: string): Effect.Effect<PoolVmRow, Error>
  destroyVm(vmId: string): Effect.Effect<void, Error>
  getVm(vmId: string): PoolVmRow | undefined
  listVms(filter?: { status?: string }): PoolVmRow[]
  updateVm(vmId: string, updates: Partial<PoolVmRow>): void
}

export { type PoolConfig }

/** Simple config for standalone pool functions */
export interface SimplePoolConfig {
  minReady: number
  idleTimeoutMs: number
  snapshotId: string
}

export function acquireVm(
  deps: PoolDeps,
  config: { minReady: number; idleTimeoutMs: number; snapshotId: string },
  taskId: string,
): Effect.Effect<PoolVmRow, Error> {
  return Effect.gen(function* () {
    const readyVms = deps.listVms({ status: "ready" })
    let vm: PoolVmRow

    if (readyVms.length > 0) {
      vm = readyVms[0]!
      deps.updateVm(vm.id, {
        status: "assigned",
        taskId,
        idleSince: null,
      })
      log.info("VM acquired", { vmId: vm.id, taskId, fromPool: true })
    } else {
      log.info("No warm VMs, provisioning on demand", { taskId })
      vm = yield* deps.provisionVm(config.snapshotId)
      deps.updateVm(vm.id, { status: "assigned", taskId })
      log.info("VM acquired", { vmId: vm.id, taskId, fromPool: false })
    }

    return vm
  })
}

export function releaseVm(
  deps: PoolDeps,
  vmId: string,
): Effect.Effect<void, Error> {
  return Effect.sync(() => {
    deps.updateVm(vmId, {
      status: "ready",
      taskId: null,
      idleSince: new Date().toISOString(),
    })
    log.info("VM released", { vmId })
  })
}

export function reapIdleVms(
  deps: PoolDeps,
  config: { minReady: number; idleTimeoutMs: number; snapshotId: string },
): Effect.Effect<{ destroyed: number }, Error> {
  return Effect.gen(function* () {
    const readyVms = deps.listVms({ status: "ready" })
    let destroyed = 0

    for (const vm of readyVms) {
      if (!vm.idleSince) continue

      const idleDurationMs = Date.now() - new Date(vm.idleSince).getTime()
      if (idleDurationMs > config.idleTimeoutMs) {
        log.info("VM reaped", { vmId: vm.id, idleDurationMs })
        yield* deps.destroyVm(vm.id)
        deps.updateVm(vm.id, { status: "destroyed" })
        destroyed++
      }
    }

    return { destroyed }
  })
}

export function reconcilePool(
  deps: PoolDeps,
  config: { minReady: number; idleTimeoutMs: number; snapshotId: string },
): Effect.Effect<{ created: number; destroyed: number }, Error> {
  return Effect.gen(function* () {
    const { destroyed } = yield* reapIdleVms(deps, config)

    const readyVms = deps.listVms({ status: "ready" })
    const deficit = config.minReady - readyVms.length
    let created = 0

    if (deficit > 0) {
      log.debug("Warming pool", { current: readyVms.length, target: config.minReady })
      for (let i = 0; i < deficit; i++) {
        yield* deps.provisionVm(config.snapshotId)
        created++
      }
    }

    log.info("Pool reconciled", { created, destroyed })
    return { created, destroyed }
  })
}

// --- VMPoolManager class (DB-backed pool with provider slots) ---

/** Row shape returned by direct DB queries in VMPoolManager */
export interface VmDbRow {
  id: string
  label: string
  provider: string
  ip: string | null
  ssh_port: number | null
  status: string
  project_id: string
  snapshot_id: string
  region: string
  plan: string
  created_at: string
  updated_at: string
  error: string | null
}

export type { VmDbRow as VmRow }

export type VmStatus = "provisioning" | "active" | "stopped" | "destroyed" | "error"

export class VMPoolManager {
  private db: Database
  private config: PoolConfig

  constructor(db: Database, config: PoolConfig) {
    this.db = db
    this.config = config
  }

  private getSlot(): ProviderSlot {
    return this.config.slots[0]!
  }

  // TODO: This class will be replaced by ProjectVmManager. Keeping it compiling for now.
  acquireVm(taskId: string): Effect.Effect<VmDbRow, Error> {
    return Effect.tryPromise({
      try: async () => {
        const slot = this.getSlot()

        // Try to find a warm VM
        const warmVm = this.db.prepare(
          "SELECT * FROM vms WHERE status = 'active' ORDER BY created_at ASC LIMIT 1"
        ).get() as VmDbRow | null

        if (warmVm) {
          this.db.prepare(
            "UPDATE vms SET status = 'active', updated_at = datetime('now') WHERE id = ?"
          ).run(warmVm.id)
          return this.db.prepare("SELECT * FROM vms WHERE id = ?").get(warmVm.id) as VmDbRow
        }

        // Provision a new VM
        const instance = await Effect.runPromise(slot.provider.createInstance({
          region: slot.region,
          plan: slot.plan,
          snapshotId: slot.snapshotId,
          label: `${this.config.labelPrefix ?? "vm"}-${crypto.randomUUID().slice(0, 8)}`,
        }))

        await Effect.runPromise(slot.provider.waitForReady(instance.id))
        await Effect.runPromise(waitForSsh(instance.ip, instance.sshPort ?? 22))

        const now = new Date().toISOString()
        this.db.prepare(`
          INSERT INTO vms (id, label, provider, ip, ssh_port, status, project_id, snapshot_id, region, plan, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
        `).run(
          instance.id, instance.label, slot.name,
          instance.ip, instance.sshPort ?? null,
          taskId, slot.snapshotId, slot.region, slot.plan,
          now, now
        )

        return this.db.prepare("SELECT * FROM vms WHERE id = ?").get(instance.id) as VmDbRow
      },
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    })
  }

  releaseVm(vmId: string): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: async () => {
        const slot = this.getSlot()

        if (slot.idleTimeoutMs === 0) {
          // Destroy immediately
          try {
            await Effect.runPromise(slot.provider.destroyInstance(vmId))
          } catch {
            // Provider destroy may fail if instance doesn't exist there
          }
          this.db.prepare(
            "UPDATE vms SET status = 'destroyed', updated_at = datetime('now') WHERE id = ?"
          ).run(vmId)
        } else {
          this.db.prepare(
            "UPDATE vms SET status = 'stopped', updated_at = datetime('now') WHERE id = ?"
          ).run(vmId)
        }
      },
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    })
  }

  reapIdleVms(): Effect.Effect<number, Error> {
    return Effect.tryPromise({
      try: async () => {
        const slot = this.getSlot()
        // Reap stopped VMs that have been idle longer than the timeout
        const stoppedVms = this.db.prepare(
          "SELECT * FROM vms WHERE status = 'stopped'"
        ).all() as VmDbRow[]

        let reaped = 0
        for (const vm of stoppedVms) {
          const idleMs = Date.now() - new Date(vm.updated_at).getTime()
          if (idleMs > slot.idleTimeoutMs) {
            try {
              await Effect.runPromise(slot.provider.destroyInstance(vm.id))
            } catch {
              // Provider destroy may fail
            }
            this.db.prepare(
              "UPDATE vms SET status = 'destroyed', updated_at = datetime('now') WHERE id = ?"
            ).run(vm.id)
            reaped++
          }
        }
        return reaped
      },
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    })
  }

  getVm(vmId: string): Effect.Effect<VmDbRow | undefined, never> {
    return Effect.sync(() => {
      return this.db.prepare("SELECT * FROM vms WHERE id = ?").get(vmId) as VmDbRow | undefined
    })
  }

  listVms(): Effect.Effect<VmDbRow[], never> {
    return Effect.sync(() => {
      return this.db.prepare("SELECT * FROM vms ORDER BY created_at DESC").all() as VmDbRow[]
    })
  }

  // TODO: Will be replaced by ProjectVmManager
  ensureWarm(): void {
    // No-op: warm pool concept is being replaced by per-project VMs
  }

  // TODO: Will be replaced by ProjectVmManager
  releaseStaleVms(): Effect.Effect<number, Error> {
    return Effect.succeed(0)
  }

  getPoolStats(): Effect.Effect<{
    provisioning: number
    active: number
    stopped: number
    total: number
    byProvider: Record<string, number>
  }, never> {
    return Effect.sync(() => {
      const rows = this.db.prepare("SELECT status, provider, COUNT(*) as count FROM vms GROUP BY status, provider").all() as Array<{
        status: string
        provider: string
        count: number
      }>

      const stats = {
        provisioning: 0,
        active: 0,
        stopped: 0,
        total: 0,
        byProvider: {} as Record<string, number>,
      }

      for (const row of rows) {
        if (row.status === "provisioning") stats.provisioning += row.count
        if (row.status === "active") stats.active += row.count
        if (row.status === "stopped") stats.stopped += row.count
        stats.total += row.count
        stats.byProvider[row.provider] = (stats.byProvider[row.provider] ?? 0) + row.count
      }

      return stats
    })
  }
}
