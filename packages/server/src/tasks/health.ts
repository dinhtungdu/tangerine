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

// Error patterns that will never self-heal — no point restarting.
// NOTE: these match human-readable strings which is fragile; ideally providers
// would emit structured error codes (see provider.ts AgentEvent).
const UNRECOVERABLE_PATTERNS = [
  /model not found/i,
  /ProviderModelNotFoundError/i,
  /invalid api key/i,
  /InvalidApiKeyError/i,
  /rate limit/i,
  /RateLimitError/i,
]

function isUnrecoverable(message: string): boolean {
  return UNRECOVERABLE_PATTERNS.some((p) => p.test(message))
}

export interface HealthCheckDeps {
  listRunningTasks(): Effect.Effect<TaskRow[], Error>
  checkAgentAlive(taskId: string): Effect.Effect<boolean, never>
  restartAgent(task: TaskRow): Effect.Effect<void, Error>
  failTask(taskId: string, reason: string): Effect.Effect<void, Error>
  /** Returns the last error emitted by the agent, if any. */
  getLastAgentError(taskId: string): string | undefined
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
      // Check if the agent reported an error before dying
      const lastError = deps.getLastAgentError(task.id)

      // Fail fast on errors that no restart can fix
      if (lastError && isUnrecoverable(lastError)) {
        taskLog.error("Agent died with unrecoverable error, skipping restart", { error: lastError })
        yield* deps.failTask(task.id, lastError).pipe(Effect.ignoreLogged)
        yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
        consecutiveRestarts.delete(task.id)
        return "failed"
      }

      const restarts = (consecutiveRestarts.get(task.id) ?? 0) + 1
      if (restarts > MAX_CONSECUTIVE_RESTARTS) {
        const reason = lastError
          ? `Agent error: ${lastError}`
          : `Agent died ${restarts} times consecutively without recovery`
        taskLog.error("Agent dead and max consecutive restarts reached, marking failed", { restarts, lastError })
        yield* deps.failTask(task.id, reason).pipe(Effect.ignoreLogged)
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
    // restartAgent succeeds → agent process spawned (lifecycle has a 60s startup timeout).
    // Don't reset consecutiveRestarts here — the agent may die again immediately.
    // The counter is only reset in checkTask when the agent is confirmed alive.
    Effect.map(() => {
      taskLog.info("Restart succeeded, awaiting next health check to confirm", { action: "agent-restart", reason })
      return "recovered" as const
    }),
    Effect.catchAll((err) =>
      Effect.gen(function* () {
        const lastError = deps.getLastAgentError(task.id)
        const failReason = lastError
          ? `Agent error: ${lastError}`
          : `Agent ${reason} and restart failed: ${err.message}`
        taskLog.error("Recovery failed, marking task failed", { error: failReason })
        yield* deps.failTask(task.id, failReason).pipe(Effect.ignoreLogged)
        yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
        return yield* new HealthCheckError({
          message: failReason,
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
