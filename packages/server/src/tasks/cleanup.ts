// Session cleanup: shutdown agent, release worktree slot.
// v1: All local — no SSH, no tunnels.

import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createLogger } from "../logger"
import { SessionCleanupError } from "../errors"
import type { TaskRow } from "../db/types"
import { releaseSlot, localExec } from "./worktree-pool"
import { isSharedServerPid } from "../agent/opencode-provider"

const log = createLogger("cleanup")

export interface CleanupDeps {
  db: Database
  getTask(taskId: string): Effect.Effect<TaskRow | null, Error>
  updateTask(taskId: string, updates: Partial<TaskRow>): Effect.Effect<unknown, Error>
  getAgentHandle(taskId: string): import("../agent/provider").AgentHandle | null
}

export function cleanupSession(
  taskId: string,
  deps: CleanupDeps,
): Effect.Effect<void, SessionCleanupError> {
  return Effect.gen(function* () {
    const task = yield* deps.getTask(taskId).pipe(
      Effect.mapError((e) => new SessionCleanupError({
        message: `Failed to get task: ${e.message}`,
        taskId,
        cause: e,
      }))
    )

    if (!task) {
      log.warn("Cleanup requested for unknown task", { taskId })
      return
    }

    const taskLog = log.child({ taskId: task.id })
    const span = taskLog.startOp("cleanup")

    // 1. Shutdown agent handle (kills local process)
    const handle = deps.getAgentHandle(taskId)
    if (handle) {
      yield* handle.shutdown().pipe(
        Effect.tap(() => Effect.sync(() => taskLog.info("Agent shutdown"))),
        Effect.ignoreLogged,
      )
    }

    // 1b. Kill agent by PID as fallback (skip shared OpenCode server — it serves other tasks)
    const agentPid = (task as TaskRow & { agent_pid?: number | null }).agent_pid
    if (agentPid && !isSharedServerPid(agentPid)) {
      yield* Effect.try(() => {
        process.kill(agentPid, "SIGTERM")
      }).pipe(
        Effect.tap(() => Effect.sync(() => taskLog.debug("Agent PID killed", { pid: agentPid }))),
        Effect.catchAll(() => Effect.void),
      )
    }

    // 2. Release worktree slot back to pool.
    // Always attempt release — releaseSlot looks up by task_id and is a no-op if no slot is bound.
    // Do NOT guard on task.worktree_path: the slot may be bound even if the path was never persisted
    // (e.g. failure between acquireSlot and updateTask).
    yield* releaseSlot(deps.db, task.id, localExec).pipe(
      Effect.tap(() => Effect.sync(() => taskLog.info("Worktree slot released"))),
      Effect.ignoreLogged,
    )

    // 3. Clear worktree_path so task isn't flagged as orphaned
    if (task.worktree_path) {
      yield* deps.updateTask(task.id, { worktree_path: null }).pipe(Effect.ignoreLogged)
    }

    span.end()
  })
}
