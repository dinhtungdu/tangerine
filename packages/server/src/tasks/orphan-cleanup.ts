// Periodic orphan cleanup: finds terminal tasks with worktree_path still set
// and cleans them up. Safety net for crashes or bugs in transition hooks.
// v1: All local — no SSH-based cleanup.

import { Effect, Schedule } from "effect"
import { createLogger } from "../logger"
import type { TaskRow } from "../db/types"
import type { CleanupDeps } from "./cleanup"
import { cleanupSession } from "./cleanup"
import { reconcileStaleSlots } from "./worktree-pool"

const log = createLogger("orphan-cleanup")

const CLEANUP_INTERVAL_MS = 30_000

export interface OrphanCleanupDeps {
  listTasks(filter?: { status?: string }): Effect.Effect<TaskRow[], Error>
  cleanupDeps: CleanupDeps
}

/** Find terminal tasks that still have a worktree_path — these are orphans.
 * Excludes any task whose worktree_path is currently referenced by an active
 * task (running/created/pending) — guards against multi-instance data races. */
export function findOrphans(
  deps: OrphanCleanupDeps,
): Effect.Effect<TaskRow[], Error> {
  return Effect.gen(function* () {
    const terminal = ["done", "failed", "cancelled"]
    const active = ["running", "created", "pending"]

    const allTerminal: TaskRow[] = []
    for (const status of terminal) {
      const tasks = yield* deps.listTasks({ status })
      allTerminal.push(...tasks)
    }

    const candidates = allTerminal.filter((t) => t.worktree_path)
    if (candidates.length === 0) return []

    // Build the set of worktree paths currently held by active tasks so we
    // don't tear down a path that another task (possibly on a second server
    // instance sharing the same DB) is still using.
    const activePaths = new Set<string>()
    for (const status of active) {
      const tasks = yield* deps.listTasks({ status })
      for (const t of tasks) {
        if (t.worktree_path) activePaths.add(t.worktree_path)
      }
    }

    return candidates.filter((t) => !activePaths.has(t.worktree_path!))
  })
}

/** Clean up orphaned worktrees for terminal tasks. Returns count cleaned. */
export function cleanupOrphans(
  deps: OrphanCleanupDeps,
): Effect.Effect<number, never> {
  return Effect.gen(function* () {
    // Reconcile stale worktree pool slots before checking orphans
    const allProjectIds = yield* Effect.try(() => {
      const rows = deps.cleanupDeps.db.prepare(
        "SELECT DISTINCT project_id FROM worktree_slots WHERE status = 'bound'",
      ).all() as { project_id: string }[]
      return rows.map((r) => r.project_id)
    }).pipe(Effect.catchAll(() => Effect.succeed([] as string[])))

    for (const projectId of allProjectIds) {
      yield* reconcileStaleSlots(deps.cleanupDeps.db, projectId, deps.cleanupDeps.getTask).pipe(
        Effect.ignoreLogged,
      )
    }

    const orphans = yield* findOrphans(deps).pipe(
      Effect.catchAll(() => Effect.succeed([] as TaskRow[]))
    )

    if (orphans.length === 0) return 0

    log.info("Found orphaned worktrees", { count: orphans.length })

    let cleaned = 0
    for (const task of orphans) {
      const taskLog = log.child({ taskId: task.id, worktree: task.worktree_path })

      yield* cleanupSession(task.id, deps.cleanupDeps).pipe(
        Effect.tap(() => Effect.sync(() => {
          taskLog.info("Orphaned worktree cleaned")
        })),
        Effect.ignoreLogged,
      )

      cleaned++
    }

    log.info("Orphan cleanup complete", { cleaned })
    return cleaned
  })
}

/** Start a repeating orphan cleanup loop as a background fiber. */
export function startOrphanCleanup(
  deps: OrphanCleanupDeps,
): Effect.Effect<void, never> {
  return cleanupOrphans(deps).pipe(
    Effect.repeat(Schedule.fixed(`${CLEANUP_INTERVAL_MS} millis`)),
    Effect.catchAll(() => Effect.void),
    Effect.asVoid,
    Effect.forkDaemon,
    Effect.asVoid,
  )
}
