// Worktree pool: pre-warm slots inside VMs, reuse between tasks.
// Slots are tracked in DB (worktree_slots table). No file-based locking
// needed — single-process server with Effect fibers.

import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import type { WorktreeSlotRow } from "../db/types"
import { DbError, SshError } from "../errors"
import { createLogger } from "../logger"

const log = createLogger("worktree-pool")

const DEFAULT_POOL_SIZE = 2

type SshExec = (
  host: string,
  port: number,
  command: string,
) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, SshError>

type GetTask = (
  id: string,
) => Effect.Effect<{ status: string } | null, Error>

function dbTry<T>(op: () => T): Effect.Effect<T, DbError> {
  return Effect.try({
    try: op,
    catch: (e) => new DbError({ message: String(e), cause: e }),
  })
}

// --- Pool initialization ---

/** Create worktree slots inside a VM if none exist yet. Idempotent. */
export function initPool(
  db: Database,
  vmId: string,
  sshExec: SshExec,
  vmIp: string,
  sshPort: number,
  poolSize: number = DEFAULT_POOL_SIZE,
): Effect.Effect<WorktreeSlotRow[], DbError | SshError> {
  return Effect.gen(function* () {
    const existing = yield* dbTry(() =>
      db.prepare("SELECT * FROM worktree_slots WHERE vm_id = ?").all(vmId) as WorktreeSlotRow[]
    )

    if (existing.length >= poolSize) {
      log.debug("Pool already initialized", { vmId, slots: existing.length })
      return existing
    }

    // Create missing slots
    yield* sshExec(vmIp, sshPort, "mkdir -p /workspace/worktrees")

    const slots: WorktreeSlotRow[] = [...existing]
    const existingIds = new Set(existing.map((s) => s.id))

    for (let i = 0; i < poolSize; i++) {
      const slotId = `${vmId}-slot-${i}`
      if (existingIds.has(slotId)) continue

      const path = `/workspace/worktrees/${slotId}`

      yield* sshExec(
        vmIp,
        sshPort,
        `cd /workspace/repo && git worktree add --detach ${path} 2>/dev/null || true`,
      )

      const row = yield* dbTry(() => {
        db.prepare(
          "INSERT OR IGNORE INTO worktree_slots (id, vm_id, path, status) VALUES ($id, $vm_id, $path, 'available')",
        ).run({ $id: slotId, $vm_id: vmId, $path: path })
        return db.prepare("SELECT * FROM worktree_slots WHERE id = ?").get(slotId) as WorktreeSlotRow
      })

      slots.push(row)
      log.info("Worktree slot created", { vmId, slotId, path })
    }

    return slots
  })
}

// --- Slot acquisition ---

/** Acquire an available slot for a task. Reconciles stale slots first. */
export function acquireSlot(
  db: Database,
  vmId: string,
  taskId: string,
  getTask: GetTask,
): Effect.Effect<WorktreeSlotRow, DbError | Error> {
  return Effect.gen(function* () {
    // Reconcile stale slots before acquiring
    yield* reconcileStaleSlots(db, vmId, getTask)

    const slot = yield* dbTry(() =>
      db.prepare(
        "SELECT * FROM worktree_slots WHERE vm_id = ? AND status = 'available' LIMIT 1",
      ).get(vmId) as WorktreeSlotRow | null
    )

    if (!slot) {
      const total = yield* dbTry(() => {
        const row = db.prepare(
          "SELECT COUNT(*) as count FROM worktree_slots WHERE vm_id = ?",
        ).get(vmId) as { count: number }
        return row.count
      })
      return yield* Effect.fail(
        new Error(`No worktree slots available (${total}/${total} bound) for VM ${vmId}`),
      )
    }

    yield* dbTry(() =>
      db.prepare(
        "UPDATE worktree_slots SET status = 'bound', task_id = ? WHERE id = ?",
      ).run(taskId, slot.id)
    )

    log.info("Slot acquired", { vmId, slotId: slot.id, taskId })
    return { ...slot, status: "bound" as const, task_id: taskId }
  })
}

// --- Slot release ---

/** Release a slot back to the pool. Resets worktree to detached HEAD. */
export function releaseSlot(
  db: Database,
  taskId: string,
  sshExec: SshExec,
  vmIp: string,
  sshPort: number,
): Effect.Effect<void, DbError | SshError> {
  return Effect.gen(function* () {
    const slot = yield* dbTry(() =>
      db.prepare(
        "SELECT * FROM worktree_slots WHERE task_id = ?",
      ).get(taskId) as WorktreeSlotRow | null
    )

    if (!slot) {
      log.debug("No slot to release", { taskId })
      return
    }

    // Reset worktree: detach HEAD, clean untracked files, reset changes
    yield* sshExec(
      vmIp,
      sshPort,
      `cd ${slot.path} && git checkout --detach HEAD 2>/dev/null; git clean -fd 2>/dev/null; git reset --hard 2>/dev/null; true`,
    ).pipe(Effect.catchAll(() => Effect.void))

    yield* dbTry(() =>
      db.prepare(
        "UPDATE worktree_slots SET status = 'available', task_id = NULL WHERE id = ?",
      ).run(slot.id)
    )

    log.info("Slot released", { slotId: slot.id, taskId })
  })
}

// --- Stale slot reconciliation ---

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"])

/** Release slots bound to terminal tasks. Prevents stale pool state. */
export function reconcileStaleSlots(
  db: Database,
  vmId: string,
  getTask: GetTask,
): Effect.Effect<number, DbError | Error> {
  return Effect.gen(function* () {
    const bound = yield* dbTry(() =>
      db.prepare(
        "SELECT * FROM worktree_slots WHERE vm_id = ? AND status = 'bound' AND task_id IS NOT NULL",
      ).all(vmId) as WorktreeSlotRow[]
    )

    let released = 0
    for (const slot of bound) {
      const task = yield* getTask(slot.task_id!).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )

      if (!task || TERMINAL_STATUSES.has(task.status)) {
        yield* dbTry(() =>
          db.prepare(
            "UPDATE worktree_slots SET status = 'available', task_id = NULL WHERE id = ?",
          ).run(slot.id)
        )
        log.info("Stale slot reconciled", { slotId: slot.id, taskId: slot.task_id })
        released++
      }
    }

    return released
  })
}

// --- Pool cleanup (VM rebuild) ---

/** Delete all slots for a VM. Called before VM rebuild. */
export function deletePoolForVm(
  db: Database,
  vmId: string,
): Effect.Effect<number, DbError> {
  return dbTry(() => {
    const result = db.prepare("DELETE FROM worktree_slots WHERE vm_id = ?").run(vmId)
    log.info("Pool deleted for VM", { vmId, deleted: result.changes })
    return Number(result.changes)
  })
}

/** Get slot bound to a specific task. */
export function getSlotForTask(
  db: Database,
  taskId: string,
): Effect.Effect<WorktreeSlotRow | null, DbError> {
  return dbTry(() =>
    db.prepare("SELECT * FROM worktree_slots WHERE task_id = ?").get(taskId) as WorktreeSlotRow | null
  )
}
