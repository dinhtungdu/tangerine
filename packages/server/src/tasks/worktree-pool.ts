// Worktree pool: pre-warm slots per project, reuse between tasks.
// Slots are tracked in DB (worktree_slots table). No file-based locking
// needed — single-process server with Effect fibers.

import { Effect } from "effect"
import path from "node:path"
import type { Database } from "bun:sqlite"
import type { WorktreeSlotRow } from "../db/types"
import { TERMINAL_STATUSES } from "@tangerine/shared"
import { DbError } from "../errors"
import { createLogger } from "../logger"

const log = createLogger("worktree-pool")

const DEFAULT_POOL_SIZE = 10

export type LocalExec = (
  command: string,
) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, Error>

// Strip git env vars so that commands cd-ing into a specific worktree use
// that worktree's repo, not an inherited GIT_DIR set by a parent git hook
// (e.g. husky pre-commit hook sets GIT_DIR for all child processes).
const GIT_ENV_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]
function cleanGitEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string | undefined>
  for (const k of GIT_ENV_KEYS) delete env[k]
  return env as Record<string, string>
}

/** Default local exec via Bun.spawn — does NOT fail on non-zero exit codes */
export const localExec: LocalExec = (command) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe", env: cleanGitEnv() })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      return { stdout, stderr, exitCode }
    },
    catch: (e) => new Error(`Local exec failed: ${e}`),
  })

/** Like localExec but fails the Effect on non-zero exit codes */
export const localExecStrict = (command: string): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, Error> =>
  localExec(command).pipe(
    Effect.flatMap((r) =>
      r.exitCode !== 0
        ? Effect.fail(new Error(`Command failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`.trim()))
        : Effect.succeed(r)
    ),
  )

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
    // Always register slot 0 (the repo clone) — used by the orchestrator.
    // No git worktree needed; it already exists as the main repo.
    const slot0Id = `${projectId}-slot-0`
    yield* dbTry(() => {
      db.prepare(
        "INSERT OR IGNORE INTO worktree_slots (id, project_id, path, status) VALUES ($id, $project_id, $path, 'available')",
      ).run({ $id: slot0Id, $project_id: projectId, $path: repoPath })
    })

    const existing = yield* dbTry(() =>
      db.prepare("SELECT * FROM worktree_slots WHERE project_id = ?").all(projectId) as WorktreeSlotRow[]
    )

    // +1 accounts for slot 0 which is not a pool worktree
    if (existing.length >= poolSize + 1) {
      log.debug("Pool already initialized", { projectId, slots: existing.length })
      return existing
    }

    // Create missing slots as siblings of 0 (the repo clone).
    // Layout: {workspace}/{project}/0 (repo), 1, 2, ...
    const projectDir = path.dirname(repoPath)

    const slots: WorktreeSlotRow[] = [...existing]
    const existingIds = new Set(existing.map((s) => s.id))

    for (let i = 1; i <= poolSize; i++) {
      const slotId = `${projectId}-slot-${i}`
      if (existingIds.has(slotId)) continue

      const slotPath = `${projectDir}/${i}`

      yield* exec(
        `cd ${repoPath} && git worktree add --detach ${slotPath} 2>/dev/null || true`,
      )

      const row = yield* dbTry(() => {
        db.prepare(
          "INSERT OR IGNORE INTO worktree_slots (id, project_id, path, status) VALUES ($id, $project_id, $path, 'available')",
        ).run({ $id: slotId, $project_id: projectId, $path: slotPath })
        return db.prepare("SELECT * FROM worktree_slots WHERE id = ?").get(slotId) as WorktreeSlotRow
      })

      slots.push(row)
      log.info("Worktree slot created", { projectId, slotId, path: slotPath })
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
  exec: LocalExec,
  defaultBranch = "main",
): Effect.Effect<WorktreeSlotRow, DbError | Error> {
  return Effect.gen(function* () {
    // Reconcile stale slots before acquiring
    yield* reconcileStaleSlots(db, projectId, getTask)

    // Exclude slot 0 (reserved for orchestrator)
    const slot0Id = `${projectId}-slot-0`
    const slot = yield* dbTry(() =>
      db.prepare(
        "SELECT * FROM worktree_slots WHERE project_id = ? AND status = 'available' AND id != ? LIMIT 1",
      ).get(projectId, slot0Id) as WorktreeSlotRow | null
    )

    if (!slot) {
      const total = yield* dbTry(() => {
        const row = db.prepare(
          "SELECT COUNT(*) as count FROM worktree_slots WHERE project_id = ? AND id != ?",
        ).get(projectId, slot0Id) as { count: number }
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

    // Ensure the worktree directory exists — initPool may have failed silently or
    // the directory may have been removed externally.
    const repoPath = yield* dbTry(() => {
      const slot0 = db.prepare(
        "SELECT path FROM worktree_slots WHERE id = ?",
      ).get(`${projectId}-slot-0`) as { path: string } | null
      if (!slot0) throw new Error(`Slot 0 not found for project ${projectId}`)
      return slot0.path
    })

    yield* exec(
      `if [ ! -d "${slot.path}" ]; then cd ${repoPath} && git worktree add --detach ${slot.path}; fi`,
    ).pipe(
      Effect.catchAll((e) =>
        dbTry(() =>
          db.prepare(
            "UPDATE worktree_slots SET status = 'available', task_id = NULL WHERE id = ?",
          ).run(slot.id)
        ).pipe(Effect.flatMap(() => Effect.fail(e)))
      )
    )

    // Fetch from origin and reset to remote HEAD so every task starts from the latest remote state.
    // On failure, release the slot to avoid permanently orphaned bound slots.
    yield* exec(
      `cd ${slot.path} && git fetch origin && git reset --hard origin/${defaultBranch} && git clean -fd`,
    ).pipe(
      Effect.catchAll((e) =>
        dbTry(() =>
          db.prepare(
            "UPDATE worktree_slots SET status = 'available', task_id = NULL WHERE id = ?",
          ).run(slot.id)
        ).pipe(Effect.flatMap(() => Effect.fail(e)))
      )
    )

    log.info("Slot acquired", { projectId, slotId: slot.id, taskId })
    return { ...slot, status: "bound" as const, task_id: taskId }
  })
}

// --- Orchestrator slot ---

/** Acquire slot 0 for an orchestrator or runner task.
 *  Slot 0 is the main repo directory — no branch isolation needed, so it is
 *  treated as a *shared* (non-exclusive) slot.  Multiple concurrent tasks
 *  (e.g. orchestrator + runner) may hold it at the same time.  No DB binding
 *  is performed, so releaseSlot is a no-op for these tasks. */
export function acquireOrchestratorSlot(
  db: Database,
  projectId: string,
  taskId: string,
  _getTask: GetTask,
): Effect.Effect<WorktreeSlotRow, DbError | Error> {
  return Effect.gen(function* () {
    const slot0Id = `${projectId}-slot-0`
    const slot = yield* dbTry(() =>
      db.prepare("SELECT * FROM worktree_slots WHERE id = ?").get(slot0Id) as WorktreeSlotRow | null
    )

    if (!slot) {
      return yield* Effect.fail(new Error(`Slot 0 not found for project ${projectId} — run initPool first`))
    }

    // No exclusive binding — slot 0 is shared across concurrent tasks.
    log.info("Slot 0 acquired (shared, no exclusive lock)", { projectId, taskId })
    return slot
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

    // Slot 0 is the main repo (orchestrator) — don't reset/detach/clean, just unbind
    if (slot.id.endsWith("-slot-0")) {
      yield* dbTry(() =>
        db.prepare(
          "UPDATE worktree_slots SET status = 'available', task_id = NULL WHERE id = ?",
        ).run(slot.id)
      )
      log.info("Orchestrator slot released (no git reset)", { slotId: slot.id, taskId })
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

/** Delete worker slots for a project. Preserves slot 0 (orchestrator). Called before project rebuild. */
export function deletePoolForProject(
  db: Database,
  projectId: string,
): Effect.Effect<number, DbError> {
  return dbTry(() => {
    const slot0Id = `${projectId}-slot-0`
    const result = db.prepare("DELETE FROM worktree_slots WHERE project_id = ? AND id != ?").run(projectId, slot0Id)
    log.info("Pool deleted for project (slot 0 preserved)", { projectId, deleted: result.changes })
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
