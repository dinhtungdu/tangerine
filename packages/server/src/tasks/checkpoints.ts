// Checkpoint lifecycle: create a snapshot on agent idle, clean up after TTL.

import { Effect, Duration } from "effect"
import crypto from "node:crypto"
import { statSync } from "node:fs"
import type { Database } from "bun:sqlite"
import { createLogger } from "../logger"
import {
  insertCheckpoint,
  listCheckpoints,
  deleteCheckpointsForTask,
  getLastAssistantSessionLogId,
  checkpointExistsForSessionLog,
  getMaxCheckpointTurnIndex,
  getTasksWithExpiredCheckpoints,
} from "../db/queries"
import { localExec } from "./worktree-pool"
import type { TangerineConfig } from "@tangerine/shared"
import { getRepoDir } from "../config"

const log = createLogger("checkpoints")

const SAFE_PATH_RE = /^[\w\-./]+$/
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MiB
const MAX_DIR_FILES = 200
const IGNORED_DIRS = new Set([
  "node_modules", ".venv", "venv", "dist", "build", ".cache", "__pycache__", ".pytest_cache"
])

/** Filter untracked files: skip large files, skip files in large/ignored dirs */
function filterUntrackedFiles(files: string[], worktreePath: string): string[] {
  const dirFileCounts = new Map<string, number>()
  for (const f of files) {
    const dir = f.split("/").slice(0, -1).join("/") || "."
    dirFileCounts.set(dir, (dirFileCounts.get(dir) ?? 0) + 1)
  }

  return files.filter(f => {
    const parts = f.split("/")
    if (parts.some(p => IGNORED_DIRS.has(p))) return false
    const dir = parts.slice(0, -1).join("/") || "."
    if ((dirFileCounts.get(dir) ?? 0) > MAX_DIR_FILES) return false
    try {
      const { size } = statSync(`${worktreePath}/${f}`)
      if (size > MAX_FILE_SIZE) return false
    } catch { return false }
    return true
  })
}

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
      // Store in /tmp, not .git — in linked worktrees .git is a file, not a directory.
      const tmpIndex = `/tmp/tangerine-checkpoint-${taskId}-${turnIndex}`
      const env = `GIT_INDEX_FILE="${tmpIndex}"`

      // Seed temp index from HEAD, then add tracked changes
      yield* localExec(`cd "${worktreePath}" && ${env} git read-tree HEAD && ${env} git add -u`)

      // Get untracked files, filter out large files and ignored dirs, add safe ones
      const { stdout: untrackedOut } = yield* localExec(
        `cd "${worktreePath}" && git ls-files --others --exclude-standard`
      )
      const untracked = untrackedOut.trim().split("\n").filter(Boolean)
      const safeFiles = filterUntrackedFiles(untracked, worktreePath)
      if (safeFiles.length > 0) {
        // Add in batches to avoid arg length limits
        for (let i = 0; i < safeFiles.length; i += 100) {
          const batch = safeFiles.slice(i, i + 100).map(f => `"${f}"`).join(" ")
          yield* localExec(`cd "${worktreePath}" && ${env} git add -- ${batch}`)
        }
      }

      const { stdout: treeOut } = yield* localExec(`cd "${worktreePath}" && ${env} git write-tree`)
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
 * Periodic garbage collector: delete checkpoint refs and DB rows for tasks
 * whose checkpoints have exceeded the configured TTL.
 *
 * Checkpoint commits stored under refs/checkpoints/{taskId}/{turnIndex} in the
 * main repo. Deleting the ref makes the commit unreachable; git gc picks it up.
 */
export function runCheckpointGc(
  db: Database,
  tangerineConfig: TangerineConfig,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const ttlHours = tangerineConfig.checkpointTtlHours ?? 24
    const expired = yield* getTasksWithExpiredCheckpoints(db, ttlHours)
    if (expired.length === 0) return

    log.info("Checkpoint GC: found expired tasks", { count: expired.length, ttlHours })

    for (const { taskId, projectId } of expired) {
      yield* Effect.gen(function* () {
        const checkpoints = yield* listCheckpoints(db, taskId)
        if (checkpoints.length === 0) return

        // Delete refs from the main repo dir (linked worktrees share the same object store).
        // Skip DB deletion if we can't reach the repo dir — leaves the task retryable on
        // the next GC run rather than orphaning refs with no pointer to delete them.
        const repoDir = getRepoDir(tangerineConfig, projectId)
        if (!repoDir || !SAFE_PATH_RE.test(repoDir)) {
          log.warn("Checkpoint GC: skipping task — repo dir unavailable or unsafe", { taskId, projectId, repoDir })
          return
        }

        // taskId is a UUID and turn_index is an integer, so interpolation is safe here.
        const deleteCommands = checkpoints
          .map((cp) => `delete refs/checkpoints/${taskId}/${cp.turn_index}`)
          .join("\n")
        yield* localExec(
          `cd "${repoDir}" && printf '%s\\n' "${deleteCommands.replace(/"/g, '\\"')}" | git update-ref --stdin 2>/dev/null || true`
        )

        yield* deleteCheckpointsForTask(db, taskId)
        log.info("Checkpoint GC: cleaned task", { taskId, count: checkpoints.length })
      }).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => log.warn("Checkpoint GC: failed for task (non-fatal)", { taskId, error: String(e) }))
        )
      )
    }
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => log.warn("Checkpoint GC failed (non-fatal)", { error: String(e) }))
    )
  )
}

/**
 * Delete checkpoint refs and DB rows for a task.
 * Called when the worktree is torn down.
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
