// Session cleanup: persist logs, kill processes, scrub credentials, release VM.
// Logging ensures cleanup failures are traceable back to the originating task.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { SessionCleanupError } from "../errors"
import type { TaskRow } from "../db/types"

const log = createLogger("cleanup")

export interface CleanupDeps {
  getSessionMessages(opencodePort: number, sessionId: string): Effect.Effect<unknown[], import("../errors").AgentError>
  persistMessages(taskId: string, messages: unknown[]): Effect.Effect<void, Error>
  sshExec(host: string, port: number, command: string): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, import("../errors").SshError>
  releaseVm(vmId: string): Effect.Effect<void, Error>
  getTask(taskId: string): Effect.Effect<TaskRow | null, Error>
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

    // Persist chat messages before tearing down the session (best-effort)
    if (task.opencode_port && task.opencode_session_id) {
      yield* Effect.gen(function* () {
        const messages = yield* deps.getSessionMessages(
          task.opencode_port!,
          task.opencode_session_id!,
        )
        yield* deps.persistMessages(task.id, messages)
        taskLog.info("Session logs persisted", { messageCount: messages.length })
      }).pipe(Effect.ignoreLogged)
    }

    if (task.vm_id) {
      // Kill agent and dev server processes inside the VM (best-effort)
      yield* deps.sshExec(
        "",
        0,
        "pkill -f opencode; pkill -f 'dev server' || true",
      ).pipe(
        Effect.tap(() => Effect.sync(() => taskLog.debug("Processes killed"))),
        Effect.ignoreLogged
      )

      // Remove injected credentials from VM before returning to pool (best-effort)
      yield* deps.sshExec(
        "",
        0,
        "rm -f /home/agent/.env /home/agent/.local/share/opencode/auth.json /home/agent/.git-credentials; unset ANTHROPIC_API_KEY GITHUB_TOKEN GH_TOKEN OPENCODE_SERVER_PASSWORD || true",
      ).pipe(
        Effect.tap(() => Effect.sync(() => taskLog.debug("Credentials scrubbed"))),
        Effect.tapError(() =>
          Effect.sync(() => taskLog.warn("Credential scrub failed, VM will be destroyed instead of recycled"))
        ),
        Effect.ignoreLogged
      )

      // Return VM to the warm pool (must succeed for cleanup to be considered complete)
      yield* deps.releaseVm(task.vm_id).pipe(
        Effect.mapError((e) => new SessionCleanupError({
          message: "VM release failed",
          taskId,
          cause: e,
        }))
      )
      taskLog.info("VM released")
    }

    span.end()
  })
}
