// Session cleanup: persist logs, shutdown agent, remove worktree.
// VM persists for the project — only the worktree is cleaned up.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { SessionCleanupError } from "../errors"
import type { TaskRow } from "../db/types"

const log = createLogger("cleanup")

export interface CleanupDeps {
  getSessionMessages(agentPort: number, sessionId: string): Effect.Effect<unknown[], import("../errors").AgentError>
  persistMessages(taskId: string, messages: unknown[]): Effect.Effect<void, Error>
  sshExec(host: string, port: number, command: string): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, import("../errors").SshError>
  getTask(taskId: string): Effect.Effect<TaskRow | null, Error>
  getVmForTask(taskId: string): Effect.Effect<{ ip: string; sshPort: number } | null, Error>
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

    const taskLog = log.child({ taskId: task.id, vmId: task.vm_id })
    const span = taskLog.startOp("cleanup")

    // 1. Persist chat messages before tearing down (best-effort)
    if (task.agent_port && task.agent_session_id) {
      yield* Effect.gen(function* () {
        const messages = yield* deps.getSessionMessages(
          task.agent_port!,
          task.agent_session_id!,
        )
        yield* deps.persistMessages(task.id, messages)
        taskLog.info("Session logs persisted", { messageCount: messages.length })
      }).pipe(Effect.ignoreLogged)
    }

    // 2. Shutdown agent handle (kills process, closes tunnel/SSE)
    const handle = deps.getAgentHandle(taskId)
    if (handle) {
      yield* handle.shutdown().pipe(
        Effect.tap(() => Effect.sync(() => taskLog.info("Agent shutdown"))),
        Effect.ignoreLogged,
      )
    }

    // 3. Remove worktree from VM (best-effort)
    if (task.worktree_path && task.vm_id) {
      const vmInfo = yield* deps.getVmForTask(taskId).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )

      if (vmInfo) {
        yield* deps.sshExec(
          vmInfo.ip,
          vmInfo.sshPort,
          `cd /workspace/repo && git worktree remove ${task.worktree_path} --force 2>/dev/null || rm -rf ${task.worktree_path}`,
        ).pipe(
          Effect.tap(() => Effect.sync(() => taskLog.info("Worktree removed", { path: task.worktree_path }))),
          Effect.ignoreLogged,
        )
      }
    }

    // NOTE: VM is NOT released/destroyed — it persists for the project

    span.end()
  })
}
