// Session cleanup: persist logs, shutdown agent, remove worktree.
// VM persists for the project — only the worktree is cleaned up.

import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createLogger } from "../logger"
import { SessionCleanupError } from "../errors"
import type { TaskRow } from "../db/types"
import type { ProxyTunnel, PreviewTunnel } from "../vm/tunnel"
import { releaseSlot } from "./worktree-pool"

const log = createLogger("cleanup")

export interface CleanupDeps {
  db: Database
  getSessionMessages(agentPort: number, sessionId: string): Effect.Effect<unknown[], import("../errors").AgentError>
  persistMessages(taskId: string, messages: unknown[]): Effect.Effect<void, Error>
  sshExec(host: string, port: number, command: string): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, import("../errors").SshError>
  getTask(taskId: string): Effect.Effect<TaskRow | null, Error>
  updateTask(taskId: string, updates: Partial<TaskRow>): Effect.Effect<unknown, Error>
  getVmForTask(taskId: string): Effect.Effect<{ ip: string; sshPort: number; status: string } | null, Error>
  getAgentHandle(taskId: string): import("../agent/provider").AgentHandle | null
  getProxyTunnel(taskId: string): ProxyTunnel | null
  getApiTunnel(taskId: string): ProxyTunnel | null
  getPreviewTunnel(taskId: string): PreviewTunnel | null
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

    // 2b. Kill proxy tunnel (reverse SSH for SOCKS proxy)
    const proxyTunnel = deps.getProxyTunnel(taskId)
    if (proxyTunnel) {
      Effect.runSync(Effect.sync(() => {
        try { proxyTunnel.process.kill() } catch { /* already dead */ }
      }))
      taskLog.debug("Proxy tunnel killed")
    }

    // 2c. Kill API reverse tunnel (cross-project task creation)
    const apiTunnel = deps.getApiTunnel(taskId)
    if (apiTunnel) {
      Effect.runSync(Effect.sync(() => {
        try { apiTunnel.process.kill() } catch { /* already dead */ }
      }))
      taskLog.debug("API tunnel killed")
    }

    // 2d. Kill preview tunnel (lazy SSH -L for dev server)
    const previewTunnel = deps.getPreviewTunnel(taskId)
    if (previewTunnel) {
      Effect.runSync(Effect.sync(() => {
        try { previewTunnel.process.kill() } catch { /* already dead */ }
      }))
      taskLog.debug("Preview tunnel killed")
    }

    // 3. Release worktree slot back to pool (resets to detached HEAD, best-effort)
    if (task.worktree_path && task.vm_id) {
      const vmInfo = yield* deps.getVmForTask(taskId).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )

      if (vmInfo && vmInfo.status !== "destroyed") {
        yield* releaseSlot(deps.db, task.id, deps.sshExec, vmInfo.ip, vmInfo.sshPort).pipe(
          Effect.tap(() => Effect.sync(() => taskLog.info("Worktree slot released", { path: task.worktree_path }))),
          Effect.ignoreLogged,
        )
      } else {
        taskLog.debug("Skipping slot release — VM unavailable", { path: task.worktree_path })
      }
    }

    // 4. Clear worktree_path so task isn't flagged as orphaned
    if (task.worktree_path) {
      yield* deps.updateTask(task.id, { worktree_path: null }).pipe(Effect.ignoreLogged)
    }

    // NOTE: VM is NOT released/destroyed — it persists for the project

    span.end()
  })
}
