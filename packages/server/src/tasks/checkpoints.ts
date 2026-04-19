// Checkpoint lifecycle: create a snapshot on agent idle, clean up after TTL.

import { Effect, Duration } from "effect"
import crypto from "node:crypto"
import type { Database } from "bun:sqlite"
import { createLogger } from "../logger"
import {
  insertCheckpoint,
  listCheckpoints,
  deleteCheckpointsForTask,
  getLastAssistantSessionLogId,
  checkpointExistsForSessionLog,
  getMaxCheckpointTurnIndex,
} from "../db/queries"
import { localExec } from "./worktree-pool"

const log = createLogger("checkpoints")

/**
 * Snapshot the worktree at the current agent idle point.
 * Auto-commits if dirty, records a detached ref and a DB row.
 * Non-fatal: swallows all errors so it never disrupts the event pipeline.
 */
const SAFE_PATH_RE = /^[\w\-./]+$/

export function snapshotCheckpoint(
  db: Database,
  taskId: string,
  worktreePath: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (!SAFE_PATH_RE.test(worktreePath)) {
      log.warn("Skipping checkpoint: unsafe worktree path", { taskId, worktreePath })
      return
    }

    // Yield to let any in-flight session log writes (fire-and-forget Effect.runPromise
    // calls in the message handler) complete before we query the DB.
    yield* Effect.sleep(Duration.millis(50))

    const sessionLogId = yield* getLastAssistantSessionLogId(db, taskId)
    if (sessionLogId === null) return // No assistant turn yet

    // Deduplicate: skip if we already have a checkpoint for this session log entry
    const exists = yield* checkpointExistsForSessionLog(db, taskId, sessionLogId)
    if (exists) return

    const maxIdx = yield* getMaxCheckpointTurnIndex(db, taskId)
    const turnIndex = maxIdx + 1

    // Build a commit object for the current worktree state without moving HEAD.
    // Using plumbing (write-tree + commit-tree) keeps the checkpoint commit off the
    // task branch so it never appears in the PR history.
    const { stdout: statusOut } = yield* localExec(`cd "${worktreePath}" && git status --porcelain`)
    const isDirty = statusOut.trim().length > 0

    let commitSha: string
    if (isDirty) {
      // Use a temporary index so we don't clobber any partially-staged files in the real worktree.
      // GIT_INDEX_FILE redirects git add/write-tree to a separate index, leaving the task's
      // staging area untouched.
      const tmpIndex = `${worktreePath}/.git/checkpoint-index-${turnIndex}`
      const { stdout: treeOut } = yield* localExec(
        `cd "${worktreePath}" && GIT_INDEX_FILE="${tmpIndex}" git add -A && GIT_INDEX_FILE="${tmpIndex}" git write-tree`
      )
      const treeSha = treeOut.trim()
      yield* localExec(`rm -f "${tmpIndex}"`)

      const { stdout: commitOut } = yield* localExec(
        `cd "${worktreePath}" && git commit-tree ${treeSha} -p HEAD -m "checkpoint: turn ${turnIndex}"`
      )
      commitSha = commitOut.trim()
    } else {
      const { stdout: headOut } = yield* localExec(`cd "${worktreePath}" && git rev-parse HEAD`)
      commitSha = headOut.trim()
    }

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
 * Called when the worktree is torn down. Phase 4 will add a TTL-based scheduler
 * so checkpoints survive long enough for the branching window before cleanup.
 */
export function cleanupTaskCheckpoints(
  db: Database,
  taskId: string,
  worktreePath: string | null,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const checkpoints = yield* listCheckpoints(db, taskId)
    if (checkpoints.length === 0) return

    // Delete git refs in a single batch if we still have access to the worktree
    if (worktreePath && SAFE_PATH_RE.test(worktreePath)) {
      const deleteCommands = checkpoints
        .map(cp => `delete refs/checkpoints/${taskId}/${cp.turn_index}`)
        .join("\n")
      yield* localExec(
        `cd "${worktreePath}" && echo "${deleteCommands}" | git update-ref --stdin 2>/dev/null || true`
      )
    }

    yield* deleteCheckpointsForTask(db, taskId)
    log.info("Checkpoints cleaned up", { taskId, count: checkpoints.length })
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => log.warn("Checkpoint cleanup failed (non-fatal)", { taskId, error: String(e) }))
    )
  )
}
