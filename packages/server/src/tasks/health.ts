// Health checker: periodically verifies running tasks are alive.
// v1: Checks agent PID instead of SSH/tunnel health.

import { Effect, Schedule } from "effect"
import { createLogger } from "../logger"
import { HealthCheckError } from "../errors"
import type { TaskRow } from "../db/types"
import type { CleanupDeps } from "./cleanup"
import { cleanupSession } from "./cleanup"

const log = createLogger("health")

const HEALTH_CHECK_INTERVAL_MS = 30_000
// After this many consecutive failed restarts, give up and mark the task failed.
// Prevents infinite restart loops if a new bug causes every restart to fail immediately.
const MAX_CONSECUTIVE_RESTARTS = 3

// Per-task consecutive restart counter — reset to 0 when the agent has real activity.
const consecutiveRestarts = new Map<string, number>()

export interface HealthCheckDeps {
  listRunningTasks(): Effect.Effect<TaskRow[], Error>
  checkAgentAlive(taskId: string): Effect.Effect<boolean, never>
  restartAgent(task: TaskRow): Effect.Effect<void, Error>
  failTask(taskId: string, reason: string): Effect.Effect<void, Error>
  cleanupDeps: CleanupDeps
}

/** Reset the restart counter when the task has real agent activity. */
export function resetRestartCount(taskId: string): void {
  consecutiveRestarts.delete(taskId)
}

export function checkTask(
  task: TaskRow,
  deps: HealthCheckDeps,
): Effect.Effect<"healthy" | "recovered" | "failed", HealthCheckError> {
  return Effect.gen(function* () {
    const taskLog = log.child({ taskId: task.id })

    // Check if agent process is alive (via PID or handle)
    const alive = yield* deps.checkAgentAlive(task.id)
    if (!alive) {
      const restarts = (consecutiveRestarts.get(task.id) ?? 0) + 1
      if (restarts > MAX_CONSECUTIVE_RESTARTS) {
        taskLog.error("Agent dead and max consecutive restarts reached, marking failed", { restarts })
        yield* deps.failTask(task.id, `Agent died ${restarts} times consecutively without recovery`).pipe(Effect.ignoreLogged)
        yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
        consecutiveRestarts.delete(task.id)
        return "failed"
      }
      consecutiveRestarts.set(task.id, restarts)
      taskLog.warn("Agent not alive, attempting restart", { attempt: restarts, maxAttempts: MAX_CONSECUTIVE_RESTARTS })
      return yield* attemptRestart(task, deps, taskLog, "agent_dead")
    }

    consecutiveRestarts.delete(task.id)
    taskLog.debug("Task healthy")
    return "healthy"
  })
}

function attemptRestart(
  task: TaskRow,
  deps: HealthCheckDeps,
  taskLog: ReturnType<typeof log.child>,
  reason: "agent_dead",
): Effect.Effect<"recovered" | "failed", HealthCheckError> {
  return deps.restartAgent(task).pipe(
    // restartAgent may internally swallow errors (reconnectSessionWithRetry has error
    // type never). Verify the agent is actually alive after restart — if not, force-fail.
    // Delay before checking: the agent process may exit shortly after spawning (e.g. SIGINT
    // on idle Claude Code), so give it time to fully exit before the liveness check.
    Effect.tap(() =>
      Effect.gen(function* () {
        yield* Effect.sleep("2 seconds")
        const aliveAfter = yield* deps.checkAgentAlive(task.id)
        if (!aliveAfter) {
          taskLog.warn("Restart returned success but agent is still not alive, forcing task to failed")
          yield* deps.failTask(task.id, `Agent ${reason} and restart did not produce a live agent`).pipe(
            Effect.ignoreLogged
          )
          yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
        } else {
          consecutiveRestarts.delete(task.id)
          taskLog.info("Recovery succeeded", { action: "agent-restart", reason })
        }
      })
    ),
    Effect.map(() => "recovered" as const),
    Effect.catchAll((err) =>
      Effect.gen(function* () {
        taskLog.error("Recovery failed, marking task failed", { reason: err.message })
        yield* deps.failTask(task.id, `Agent ${reason} and restart failed: ${err.message}`).pipe(
          Effect.ignoreLogged
        )
        yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
        return yield* new HealthCheckError({
          message: `Agent ${reason} and restart failed`,
          taskId: task.id,
          reason,
        })
      })
    ),
  )
}

export function checkAllTasks(
  deps: HealthCheckDeps,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const tasks = yield* deps.listRunningTasks().pipe(
      Effect.catchAll(() => Effect.succeed([] as TaskRow[]))
    )
    log.debug("Health check started", { runningTaskCount: tasks.length })

    for (const task of tasks) {
      yield* checkTask(task, deps).pipe(
        Effect.catchAll((error) => {
          log.error("Health check error", {
            taskId: task.id,
            error: error.message,
          })
          return Effect.void
        }),
        // Catch defects too so one bad task can't crash the health monitor
        Effect.catchAllDefect((defect) => {
          log.error("Health check defect", {
            taskId: task.id,
            defect: String(defect),
          })
          return Effect.void
        }),
      )
    }
  })
}

/**
 * Starts a repeating health check loop as a background fiber.
 * Errors are caught internally so the monitor never crashes.
 */
export function startHealthMonitor(
  deps: HealthCheckDeps,
): Effect.Effect<void, never> {
  return checkAllTasks(deps).pipe(
    Effect.repeat(Schedule.fixed(`${HEALTH_CHECK_INTERVAL_MS} millis`)),
    Effect.catchAll(() => Effect.void),
    Effect.catchAllDefect((defect) => {
      log.error("Health monitor defect, restarting", { defect: String(defect) })
      return Effect.void
    }),
    Effect.asVoid,
    Effect.forkDaemon,
    Effect.asVoid,
  )
}
