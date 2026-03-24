// Per-project VM manager: one persistent VM per project, no pool.
// VMs survive task completion and server restarts. Tasks use git worktrees for isolation.

import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createLogger } from "../logger"
import { waitForSsh } from "./ssh"
import type { Provider } from "./providers/types"
import { BASE_VM_NAME, runProjectSetup } from "../image/build"

const log = createLogger("project-vm")

export type ProjectVmStatus = "provisioning" | "active" | "stopped" | "destroyed" | "error"

/** Row shape from the vms table (per-project model) */
export interface ProjectVmRow {
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

export interface ProjectVmConfig {
  provider: Provider
  providerName: string
  region: string
  plan: string
}

export class ProjectVmManager {
  private db: Database
  private config: ProjectVmConfig

  constructor(db: Database, config: ProjectVmConfig) {
    this.db = db
    this.config = config
  }

  /**
   * Get existing active VM for a project, or provision a new one.
   * New VMs are cloned directly from the base image. Project-specific
   * setup (build.sh) runs on first provisioning and is cached on the VM.
   */
  getOrCreateVm(projectId: string, imageName: string): Effect.Effect<ProjectVmRow, Error> {
    return Effect.gen(this, function* (_) {
      // Check for existing active VM
      const existing = this.db
        .prepare(
          "SELECT * FROM vms WHERE project_id = ? AND status IN ('active', 'provisioning') ORDER BY created_at DESC LIMIT 1",
        )
        .get(projectId) as ProjectVmRow | null

      if (existing) {
        log.info("Using existing VM", { vmId: existing.id, projectId, status: existing.status })

        // If still provisioning, wait for it
        if (existing.status === "provisioning") {
          yield* this.waitForVmReady(existing.id)
          return this.db.prepare("SELECT * FROM vms WHERE id = ?").get(existing.id) as ProjectVmRow
        }

        return existing
      }

      // Clone directly from base VM
      const snapshotId = `clone:${BASE_VM_NAME}`
      const label = `tangerine-${projectId}-${crypto.randomUUID().slice(0, 8)}`

      log.info("Provisioning VM for project", { projectId, label, snapshotId })

      // Insert provisioning record first
      const now = new Date().toISOString()
      const vmId = label // Lima uses the label as ID
      this.db
        .prepare(
          `INSERT INTO vms (id, label, provider, status, project_id, snapshot_id, region, plan, created_at, updated_at)
         VALUES (?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?)`,
        )
        .run(vmId, label, this.config.providerName, projectId, snapshotId, this.config.region, this.config.plan, now, now)

      const provision = Effect.gen(this, function* () {
        const instance = yield* this.config.provider
          .createInstance({
            region: this.config.region,
            plan: this.config.plan,
            snapshotId,
            label,
          })
          .pipe(Effect.mapError((e) => new Error(`VM provisioning failed: ${e.message}`)))

        yield* this.config.provider.waitForReady(instance.id).pipe(
          Effect.mapError((e) => new Error(`VM never became ready: ${e.message}`)),
        )

        yield* waitForSsh(instance.ip, instance.sshPort ?? 22).pipe(
          Effect.mapError((e) => new Error(`SSH not available: ${e.message}`)),
        )

        // Run project-specific setup (build.sh) on first provision
        yield* Effect.tryPromise({
          try: () => runProjectSetup(imageName, instance.ip, instance.sshPort ?? 22, log),
          catch: (e) => new Error(`Project setup failed: ${e}`),
        })

        // Mark active
        this.db
          .prepare(
            "UPDATE vms SET status = 'active', ip = ?, ssh_port = ?, updated_at = datetime('now') WHERE id = ?",
          )
          .run(instance.ip, instance.sshPort ?? null, vmId)

        log.info("VM provisioned", { vmId, projectId, ip: instance.ip })
        return this.db.prepare("SELECT * FROM vms WHERE id = ?").get(vmId) as ProjectVmRow
      })

      return yield* provision.pipe(
        Effect.catchAll((err) => {
          this.db
            .prepare("UPDATE vms SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?")
            .run(String(err), vmId)
          return Effect.fail(err)
        }),
      )
    })
  }

  /** Get VM for a project (null if none active) */
  getProjectVm(projectId: string): Effect.Effect<ProjectVmRow | null, never> {
    return Effect.sync(() => {
      return this.db
        .prepare(
          "SELECT * FROM vms WHERE project_id = ? AND status IN ('active', 'provisioning') ORDER BY created_at DESC LIMIT 1",
        )
        .get(projectId) as ProjectVmRow | null
    })
  }

  /** Stop a project VM (user action — can be restarted later) */
  stopVm(projectId: string): Effect.Effect<void, Error> {
    return Effect.gen(this, function* (_) {
      const vm = this.db
        .prepare("SELECT * FROM vms WHERE project_id = ? AND status = 'active' LIMIT 1")
        .get(projectId) as ProjectVmRow | null

      if (!vm) {
        return yield* Effect.fail(new Error(`No active VM for project ${projectId}`))
      }

      yield* this.config.provider.stopInstance(vm.id).pipe(
        Effect.mapError((e) => new Error(`Failed to stop VM: ${e.message}`)),
      )

      this.db
        .prepare("UPDATE vms SET status = 'stopped', updated_at = datetime('now') WHERE id = ?")
        .run(vm.id)

      log.info("VM stopped", { vmId: vm.id, projectId })
    })
  }

  /** Destroy a project VM permanently */
  destroyVm(projectId: string): Effect.Effect<void, Error> {
    return Effect.gen(this, function* (_) {
      const vm = this.db
        .prepare("SELECT * FROM vms WHERE project_id = ? AND status IN ('active', 'stopped', 'error') LIMIT 1")
        .get(projectId) as ProjectVmRow | null

      if (!vm) {
        return yield* Effect.fail(new Error(`No VM to destroy for project ${projectId}`))
      }

      yield* this.config.provider.destroyInstance(vm.id).pipe(
        Effect.catchAll(() => Effect.void), // Provider destroy may fail if already gone
      )

      this.db
        .prepare("UPDATE vms SET status = 'destroyed', updated_at = datetime('now') WHERE id = ?")
        .run(vm.id)

      log.info("VM destroyed", { vmId: vm.id, projectId })
    })
  }

  /** Destroy a specific VM by ID */
  destroyVmById(vmId: string): Effect.Effect<void, Error> {
    return Effect.gen(this, function* (_) {
      const vm = this.db.prepare("SELECT * FROM vms WHERE id = ?").get(vmId) as ProjectVmRow | null
      if (!vm) {
        return yield* Effect.fail(new Error(`VM ${vmId} not found`))
      }

      yield* this.config.provider.destroyInstance(vm.id).pipe(
        Effect.catchAll(() => Effect.void),
      )

      this.db
        .prepare("UPDATE vms SET status = 'destroyed', updated_at = datetime('now') WHERE id = ?")
        .run(vm.id)

      log.info("VM destroyed", { vmId })
    })
  }

  /** List all non-destroyed VMs */
  listVms(): Effect.Effect<ProjectVmRow[], never> {
    return Effect.sync(() => {
      return this.db
        .prepare("SELECT * FROM vms WHERE status != 'destroyed' ORDER BY created_at DESC")
        .all() as ProjectVmRow[]
    })
  }

  /** Get a single VM by ID */
  getVm(vmId: string): Effect.Effect<ProjectVmRow | null, never> {
    return Effect.sync(() => {
      return this.db.prepare("SELECT * FROM vms WHERE id = ?").get(vmId) as ProjectVmRow | null
    })
  }

  /**
   * On server startup: verify active VMs are still alive via provider.
   * Dead VMs get marked as error.
   */
  reconcileOnStartup(): Effect.Effect<{ alive: number; dead: number }, never> {
    return Effect.gen(this, function* (_) {
      const vms = this.db
        .prepare("SELECT * FROM vms WHERE status IN ('active', 'provisioning')")
        .all() as ProjectVmRow[]

      let alive = 0
      let dead = 0

      for (const vm of vms) {
        const instance = yield* this.config.provider.getInstance(vm.id).pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        )

        if (!instance || instance.status === "error" || instance.status === "stopped") {
          log.warn("VM no longer alive, marking error", { vmId: vm.id, projectId: vm.project_id, previousStatus: vm.status })
          this.db
            .prepare("UPDATE vms SET status = 'error', error = 'VM not running on startup', updated_at = datetime('now') WHERE id = ?")
            .run(vm.id)
          dead++
        } else if (vm.status === "provisioning" && instance.ip) {
          // Stale provisioning — VM is actually running, update to active
          log.info("Stale provisioning VM is running, marking active", { vmId: vm.id, projectId: vm.project_id, ip: instance.ip })
          this.db
            .prepare("UPDATE vms SET status = 'active', ip = ?, ssh_port = ?, updated_at = datetime('now') WHERE id = ?")
            .run(instance.ip, instance.sshPort ?? null, vm.id)
          alive++
        } else {
          alive++
        }
      }

      if (dead > 0 || alive > 0) {
        log.info("Startup VM reconciliation", { alive, dead })
      }

      return { alive, dead }
    })
  }

  /** Wait for a provisioning VM to become active (poll DB) */
  private waitForVmReady(vmId: string): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: async () => {
        const maxAttempts = 60
        for (let i = 0; i < maxAttempts; i++) {
          const vm = this.db.prepare("SELECT status FROM vms WHERE id = ?").get(vmId) as { status: string } | null
          if (!vm) throw new Error(`VM ${vmId} disappeared`)
          if (vm.status === "active") return
          if (vm.status === "error" || vm.status === "destroyed") {
            throw new Error(`VM ${vmId} entered ${vm.status} state`)
          }
          await new Promise((r) => setTimeout(r, 2000))
        }
        throw new Error(`VM ${vmId} did not become ready in time`)
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    })
  }
}
