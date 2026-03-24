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

export interface HealthCheckDeps {
  listRunningTasks(): Effect.Effect<TaskRow[], Error>
  checkAgentAlive(taskId: string): Effect.Effect<boolean, never>
  restartAgent(task: TaskRow): Effect.Effect<void, Error>
  failTask(taskId: string, reason: string): Effect.Effect<void, Error>
  cleanupDeps: CleanupDeps
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
      taskLog.warn("Agent not alive, attempting restart")

      const restartResult = yield* deps.restartAgent(task).pipe(
        Effect.map(() => "recovered" as const),
        Effect.catchAll((err) => {
          taskLog.error("Recovery failed, marking task failed", {
            reason: err.message,
          })
          return Effect.gen(function* () {
            yield* deps.failTask(task.id, "Agent process died and restart failed").pipe(
              Effect.ignoreLogged
            )
            yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
            return "failed" as const
          })
        })
      )

      if (restartResult === "recovered") {
        taskLog.info("Recovery succeeded", { action: "agent-restart" })
        return "recovered"
      }

      return yield* new HealthCheckError({
        message: "Agent process died and restart failed",
        taskId: task.id,
        reason: "agent_dead",
      })
    }

    taskLog.debug("Task healthy")
    return "healthy"
  })
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
        })
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
    Effect.asVoid,
    Effect.fork,
    Effect.asVoid,
  )
}
