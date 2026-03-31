// Health checker: periodically verifies running tasks are alive.
// v1: Checks agent PID instead of SSH/tunnel health.

import { Effect, Schedule } from "effect"
import { createLogger } from "../logger"
import { HealthCheckError } from "../errors"
import { DEFAULT_IDLE_TIMEOUT_MS } from "@tangerine/shared"
import type { TaskRow } from "../db/types"
import type { CleanupDeps } from "./cleanup"
import { cleanupSession } from "./cleanup"
import { getTaskState, clearTaskState } from "./task-state"
import { utc } from "../api/helpers"

const log = createLogger("health")

const HEALTH_CHECK_INTERVAL_MS = 30_000
// After this many consecutive failed restarts, give up and mark the task failed.
// Prevents infinite restart loops if a new bug causes every restart to fail immediately.
const MAX_CONSECUTIVE_RESTARTS = 3

/**
 * Parse a SQLite/ISO timestamp into epoch milliseconds.
 * Uses utc() to normalize bare SQLite timestamps to proper UTC.
 */
export function parseTaskTimestampMs(timestamp: string): number {
  return new Date(utc(timestamp) ?? timestamp).getTime()
}

/** Check whether a task's agent has been suspended due to idle timeout. */
export function isTaskSuspended(taskId: string): boolean {
  return getTaskState(taskId).suspended
}

/** Clear the suspended flag when a task's agent is restarted. */
export function clearSuspended(taskId: string): void {
  getTaskState(taskId).suspended = false
}

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
  /payment required/i,
  /deactivated.workspace/i,
  /insufficient.quota/i,
  /billing/i,
]

function isUnrecoverable(message: string): boolean {
  return UNRECOVERABLE_PATTERNS.some((p) => p.test(message))
}

export interface HealthCheckDeps {
  listRunningTasks(): Effect.Effect<TaskRow[], Error>
  checkAgentAlive(taskId: string): Effect.Effect<boolean, never>
  restartAgent(task: TaskRow): Effect.Effect<void, Error>
  failTask(taskId: string, reason: string): Effect.Effect<void, Error>
  /** Shut down the agent process without changing task status. */
  suspendAgent(taskId: string): Effect.Effect<void, never>
  /** Returns the last error emitted by the agent, if any. */
  getLastAgentError(taskId: string): string | undefined
  /** Returns the ISO timestamp of the most recent user message for a task, or null. */
  getLastUserMessageTime(taskId: string): string | null
  /** Returns whether the agent is currently processing (working) or idle. */
  isAgentWorking(taskId: string): boolean
  /** Log an activity entry when an agent is suspended due to idle timeout. */
  logSuspend(taskId: string, idleMs: number): Effect.Effect<void, never>
  cleanupDeps: CleanupDeps
}

/** Reset the restart counter when the task has real agent activity. */
export function resetRestartCount(taskId: string): void {
  getTaskState(taskId).consecutiveRestarts = 0
}

export function checkTask(
  task: TaskRow,
  deps: HealthCheckDeps,
): Effect.Effect<"healthy" | "recovered" | "failed", HealthCheckError> {
  return Effect.gen(function* () {
    const taskLog = log.child({ taskId: task.id })

    // Check if agent process is alive (via PID or handle)
    const state = getTaskState(task.id)
    const alive = yield* deps.checkAgentAlive(task.id)
    if (!alive) {
      // Skip restart for tasks intentionally suspended due to idle timeout
      if (state.suspended) {
        taskLog.debug("Task suspended (idle), skipping restart")
        return "healthy"
      }

      // Check if the agent reported an error before dying
      const lastError = deps.getLastAgentError(task.id)

      // Fail fast on errors that no restart can fix
      if (lastError && isUnrecoverable(lastError)) {
        taskLog.error("Agent died with unrecoverable error, skipping restart", { error: lastError })
        yield* deps.failTask(task.id, lastError).pipe(Effect.ignoreLogged)
        yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
        clearTaskState(task.id)
        return "failed"
      }

      state.consecutiveRestarts += 1
      const restarts = state.consecutiveRestarts
      if (restarts > MAX_CONSECUTIVE_RESTARTS) {
        const reason = lastError
          ? `Agent error: ${lastError}`
          : `Agent died ${restarts} times consecutively without recovery`
        taskLog.error("Agent dead and max consecutive restarts reached, marking failed", { restarts, lastError })
        yield* deps.failTask(task.id, reason).pipe(Effect.ignoreLogged)
        yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
        clearTaskState(task.id)
        return "failed"
      }
      taskLog.warn("Agent not alive, attempting restart", { attempt: restarts, maxAttempts: MAX_CONSECUTIVE_RESTARTS })
      return yield* attemptRestart(task, deps, taskLog, "agent_dead")
    }

    // Agent process is alive, but check if it reported an unrecoverable error.
    // For OpenCode, the server process stays alive even after API errors like
    // billing issues — the process is healthy but can't do any useful work.
    const lastError = deps.getLastAgentError(task.id)
    if (lastError && isUnrecoverable(lastError)) {
      taskLog.error("Agent alive but reported unrecoverable error, marking failed", { error: lastError })
      yield* deps.failTask(task.id, lastError).pipe(Effect.ignoreLogged)
      yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
      clearTaskState(task.id)
      return "failed"
    }

    state.consecutiveRestarts = 0
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
        clearTaskState(task.id)
        return yield* new HealthCheckError({
          message: failReason,
          taskId: task.id,
          reason,
        })
      })
    ),
  )
}

// Providers that persist sessions to disk and support resume after process kill.
const SUSPENDABLE_PROVIDERS = new Set(["claude-code", "codex", "opencode"])

/**
 * Suspend a running task's agent if it has been idle (no user messages) for
 * longer than DEFAULT_IDLE_TIMEOUT_MS. The task stays "running" — the agent
 * process is killed to free resources but restarts on next user message.
 * Only applies to providers that support disk-based resume (claude-code, codex).
 */
function checkIdleTimeout(
  task: TaskRow,
  deps: HealthCheckDeps,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (!SUSPENDABLE_PROVIDERS.has(task.provider)) return

    const state = getTaskState(task.id)

    // Already suspended — don't re-log or re-suspend
    if (state.suspended) return

    // Don't suspend if the agent is actively processing a request
    if (deps.isAgentWorking(task.id)) return

    const lastMsgTime = deps.getLastUserMessageTime(task.id)
    if (lastMsgTime) {
      const idleMs = Date.now() - parseTaskTimestampMs(lastMsgTime)
      if (idleMs >= DEFAULT_IDLE_TIMEOUT_MS) {
        log.info("Task idle, suspending agent", { taskId: task.id, title: task.title, idleMs })
        state.suspended = true
        yield* deps.suspendAgent(task.id)
        yield* deps.logSuspend(task.id, idleMs)
        return
      }
    } else if (task.started_at) {
      // No user messages at all — check time since start
      const idleMs = Date.now() - parseTaskTimestampMs(task.started_at)
      if (idleMs >= DEFAULT_IDLE_TIMEOUT_MS) {
        log.info("Task idle (no messages), suspending agent", { taskId: task.id, title: task.title, idleMs })
        state.suspended = true
        yield* deps.suspendAgent(task.id)
        yield* deps.logSuspend(task.id, idleMs)
      }
    }
  }).pipe(Effect.catchAll(() => Effect.void))
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
      const result = yield* checkTask(task, deps).pipe(
        Effect.catchAll((error) => {
          log.error("Health check error", {
            taskId: task.id,
            error: error.message,
          })
          return Effect.succeed("failed" as const)
        }),
        // Catch defects too so one bad task can't crash the health monitor
        Effect.catchAllDefect((defect) => {
          log.error("Health check defect", {
            taskId: task.id,
            defect: String(defect),
          })
          return Effect.succeed("failed" as const)
        }),
      )

      // Idle timeout: complete tasks with no user activity.
      // Only check if the task is still healthy — skip if it was just restarted or failed.
      if (result === "healthy") {
        yield* checkIdleTimeout(task, deps)
      }
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
