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
// If no agent activity for this long, consider the session stalled and restart
const STALL_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

export interface HealthCheckDeps {
  listRunningTasks(): Effect.Effect<TaskRow[], Error>
  checkAgentAlive(taskId: string): Effect.Effect<boolean, never>
  /** Returns the timestamp of the last agent activity, or null if unknown */
  getLastActivityTime?(taskId: string): Effect.Effect<Date | null, never>
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
      return yield* attemptRestart(task, deps, taskLog, "agent_dead")
    }

    // Agent is alive — but check for stalled sessions (alive but making no progress)
    if (deps.getLastActivityTime) {
      const lastActivity = yield* deps.getLastActivityTime(task.id)
      if (lastActivity) {
        const stalledMs = Date.now() - lastActivity.getTime()
        if (stalledMs > STALL_THRESHOLD_MS) {
          taskLog.warn("Agent stalled (no activity), attempting restart", {
            stalledMs,
            lastActivity: lastActivity.toISOString(),
          })
          return yield* attemptRestart(task, deps, taskLog, "agent_stalled")
        }
      }
    }

    taskLog.debug("Task healthy")
    return "healthy"
  })
}

function attemptRestart(
  task: TaskRow,
  deps: HealthCheckDeps,
  taskLog: ReturnType<typeof log.child>,
  reason: "agent_dead" | "agent_stalled",
): Effect.Effect<"recovered" | "failed", HealthCheckError> {
  return deps.restartAgent(task).pipe(
    Effect.tap(() => Effect.sync(() => {
      taskLog.info("Recovery succeeded", { action: "agent-restart", reason })
    })),
    Effect.map(() => "recovered" as const),
    Effect.catchAll((err) =>
      Effect.gen(function* () {
        taskLog.error("Recovery failed, marking task failed", { reason: err.message })
        yield* deps.failTask(task.id, `Agent ${reason} and restart failed`).pipe(
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
