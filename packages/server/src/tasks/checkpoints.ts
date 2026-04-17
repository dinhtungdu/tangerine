// Checkpoint lifecycle: create a snapshot on agent idle, clean up after TTL.

import { Effect } from "effect"
import crypto from "node:crypto"
import type { Database } from "bun:sqlite"
import { createLogger } from "../logger"
import {
  insertCheckpoint,
  listCheckpoints,
  deleteCheckpointsForTask,
  getLastAssistantSessionLogId,
} from "../db/queries"
import { localExec } from "./worktree-pool"

const log = createLogger("checkpoints")

// Default TTL: keep checkpoints 24 hours after task reaches terminal state
export const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Snapshot the worktree at the current agent idle point.
 * Auto-commits if dirty, records a detached ref and a DB row.
 * Non-fatal: swallows all errors so it never disrupts the event pipeline.
 */
export function snapshotCheckpoint(
  db: Database,
  taskId: string,
  worktreePath: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const sessionLogId = yield* getLastAssistantSessionLogId(db, taskId)
    if (sessionLogId === null) return // No assistant turn yet

    // Deduplicate: skip if we already have a checkpoint for this session log entry
    const existing = yield* listCheckpoints(db, taskId)
    if (existing.some(cp => cp.session_log_id === sessionLogId)) return

    const turnIndex = existing.length

    // Auto-commit worktree if dirty
    const { stdout: statusOut } = yield* localExec(`cd "${worktreePath}" && git status --porcelain`)
    if (statusOut.trim().length > 0) {
      yield* localExec(
        `cd "${worktreePath}" && git add -A && git commit -m "checkpoint: turn ${turnIndex}" --no-verify --quiet`
      )
    }

    // Capture HEAD SHA
    const { stdout: shaOut } = yield* localExec(`cd "${worktreePath}" && git rev-parse HEAD`)
    const commitSha = shaOut.trim()
    if (!commitSha) return

    // Write detached ref so the commit stays reachable without polluting the task branch
    yield* localExec(
      `cd "${worktreePath}" && git update-ref refs/checkpoints/${taskId}/${turnIndex} ${commitSha}`
    )

    const id = crypto.randomUUID()
    yield* insertCheckpoint(db, { id, task_id: taskId, session_log_id: sessionLogId, commit_sha: commitSha, turn_index: turnIndex })

    log.debug("Checkpoint created", { taskId, turnIndex, commitSha })
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => log.warn("Checkpoint creation failed (non-fatal)", { taskId, error: String(e) }))
    )
  )
}

/**
 * Delete checkpoint refs and DB rows for a task.
 * Respects TTL: skips cleanup if completedAt is more recent than ttlMs.
 * Pass completedAt=null to force immediate cleanup (e.g. on explicit delete).
 */
export function cleanupTaskCheckpoints(
  db: Database,
  taskId: string,
  worktreePath: string | null,
  completedAt: string | null,
  ttlMs = CHECKPOINT_TTL_MS,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    // Enforce TTL: skip if the task completed recently and branching window is still open
    if (completedAt !== null) {
      const ageMs = Date.now() - new Date(completedAt).getTime()
      if (ageMs < ttlMs) return
    }

    const checkpoints = yield* listCheckpoints(db, taskId)
    if (checkpoints.length === 0) return

    // Delete git refs if we still have access to the worktree
    if (worktreePath) {
      for (const cp of checkpoints) {
        yield* localExec(
          `cd "${worktreePath}" && git update-ref -d refs/checkpoints/${taskId}/${cp.turn_index} 2>/dev/null || true`
        )
      }
    }

    yield* deleteCheckpointsForTask(db, taskId)
    log.info("Checkpoints cleaned up", { taskId, count: checkpoints.length })
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => log.warn("Checkpoint cleanup failed (non-fatal)", { taskId, error: String(e) }))
    )
  )
}
