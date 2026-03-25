// Worktree pool: pre-warm slots per project, reuse between tasks.
// Slots are tracked in DB (worktree_slots table). No file-based locking
// needed — single-process server with Effect fibers.

import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import type { WorktreeSlotRow } from "../db/types"
import { DbError } from "../errors"
import { createLogger } from "../logger"

const log = createLogger("worktree-pool")

const DEFAULT_POOL_SIZE = 10

export type LocalExec = (
  command: string,
) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, Error>

/** Default local exec via Bun.spawn */
export const localExec: LocalExec = (command) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      return { stdout, stderr, exitCode }
    },
    catch: (e) => new Error(`Local exec failed: ${e}`),
  })

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

/** Create worktree slots for a project if none exist yet. Idempotent. */
export function initPool(
  db: Database,
  projectId: string,
  exec: LocalExec,
  repoPath: string,
  poolSize: number = DEFAULT_POOL_SIZE,
): Effect.Effect<WorktreeSlotRow[], DbError | Error> {
  return Effect.gen(function* () {
    const existing = yield* dbTry(() =>
      db.prepare("SELECT * FROM worktree_slots WHERE project_id = ?").all(projectId) as WorktreeSlotRow[]
    )

    if (existing.length >= poolSize) {
      log.debug("Pool already initialized", { projectId, slots: existing.length })
      return existing
    }

    // Create missing slots
    // Place worktrees as a sibling of the repo dir, not inside it.
    // Inside the repo they appear as untracked paths and pollute git status.
    const worktreesDir = `${repoPath}/../worktrees`
    yield* exec(`mkdir -p ${worktreesDir}`)

    const slots: WorktreeSlotRow[] = [...existing]
    const existingIds = new Set(existing.map((s) => s.id))

    for (let i = 0; i < poolSize; i++) {
      const slotId = `${projectId}-slot-${i}`
      if (existingIds.has(slotId)) continue

      const path = `${worktreesDir}/${slotId}`

      yield* exec(
        `cd ${repoPath} && git worktree add --detach ${path} 2>/dev/null || true`,
      )

      const row = yield* dbTry(() => {
        db.prepare(
          "INSERT OR IGNORE INTO worktree_slots (id, project_id, path, status) VALUES ($id, $project_id, $path, 'available')",
        ).run({ $id: slotId, $project_id: projectId, $path: path })
        return db.prepare("SELECT * FROM worktree_slots WHERE id = ?").get(slotId) as WorktreeSlotRow
      })

      slots.push(row)
      log.info("Worktree slot created", { projectId, slotId, path })
    }

    return slots
  })
}

// --- Slot acquisition ---

/** Acquire an available slot for a task. Reconciles stale slots first. */
export function acquireSlot(
  db: Database,
  projectId: string,
  taskId: string,
  getTask: GetTask,
): Effect.Effect<WorktreeSlotRow, DbError | Error> {
  return Effect.gen(function* () {
    // Reconcile stale slots before acquiring
    yield* reconcileStaleSlots(db, projectId, getTask)

    const slot = yield* dbTry(() =>
      db.prepare(
        "SELECT * FROM worktree_slots WHERE project_id = ? AND status = 'available' LIMIT 1",
      ).get(projectId) as WorktreeSlotRow | null
    )

    if (!slot) {
      const total = yield* dbTry(() => {
        const row = db.prepare(
          "SELECT COUNT(*) as count FROM worktree_slots WHERE project_id = ?",
        ).get(projectId) as { count: number }
        return row.count
      })
      return yield* Effect.fail(
        new Error(`No worktree slots available (${total}/${total} bound) for project ${projectId}`),
      )
    }

    yield* dbTry(() =>
      db.prepare(
        "UPDATE worktree_slots SET status = 'bound', task_id = ? WHERE id = ?",
      ).run(taskId, slot.id)
    )

    log.info("Slot acquired", { projectId, slotId: slot.id, taskId })
    return { ...slot, status: "bound" as const, task_id: taskId }
  })
}

// --- Slot release ---

/** Release a slot back to the pool. Resets worktree to detached HEAD. */
export function releaseSlot(
  db: Database,
  taskId: string,
  exec: LocalExec,
): Effect.Effect<void, DbError | Error> {
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
    yield* exec(
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
  projectId: string,
  getTask: GetTask,
): Effect.Effect<number, DbError | Error> {
  return Effect.gen(function* () {
    const bound = yield* dbTry(() =>
      db.prepare(
        "SELECT * FROM worktree_slots WHERE project_id = ? AND status = 'bound' AND task_id IS NOT NULL",
      ).all(projectId) as WorktreeSlotRow[]
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

// --- Pool cleanup ---

/** Delete all slots for a project. Called before project rebuild. */
export function deletePoolForProject(
  db: Database,
  projectId: string,
): Effect.Effect<number, DbError> {
  return dbTry(() => {
    const result = db.prepare("DELETE FROM worktree_slots WHERE project_id = ?").run(projectId)
    log.info("Pool deleted for project", { projectId, deleted: result.changes })
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
