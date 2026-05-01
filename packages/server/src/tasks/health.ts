// Health checker: periodically verifies running ACP agent processes are alive.

import { Effect, Schedule } from "effect"
import { createLogger } from "../logger"
import { HealthCheckError } from "../errors"
import { DEFAULT_IDLE_TIMEOUT_MS } from "@tangerine/shared"
import type { TaskRow } from "../db/types"
import type { CleanupDeps } from "./cleanup"
import { cleanupSession } from "./cleanup"
import { getTaskState, clearTaskState, resetOrphanState } from "./task-state"
import { clearQueue } from "../agent/prompt-queue"
import { utc } from "../api/helpers"

const log = createLogger("health")

const HEALTH_CHECK_INTERVAL_MS = 30_000
// After this many consecutive failed restarts, give up and mark the task failed.
// Prevents infinite restart loops if a new bug causes every restart to fail immediately.
const MAX_CONSECUTIVE_RESTARTS = 3
// After this many health checks without an agent handle, consider the task orphaned.
// Must be <= MAX_CONSECUTIVE_RESTARTS + 1 so orphan handling fires before restart limit.
const MAX_ORPHAN_CHECKS = 4
// Cooldown between orphan recovery attempts (ms). Prevents spamming reconnects.
const ORPHAN_RECOVERY_COOLDOWN_MS = 60_000
// A tool that has been "running" in the DB for longer than this is considered hung.
const HUNG_TOOL_TIMEOUT_MS = 5 * 60 * 1000
// After aborting for a hung tool, don't re-abort for this long — the old
// tool.start entry stays in the DB until the restarted agent logs new activity.
const HUNG_TOOL_COOLDOWN_MS = HUNG_TOOL_TIMEOUT_MS * 2

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
  /** Returns whether the agent is currently processing (working) or idle (stall-aware). */
  isAgentWorking(taskId: string): boolean
  /** Returns raw working state (ignores stall timeout). Used by hung-tool check. */
  isAgentWorkingRaw(taskId: string): boolean
  /** Log an activity entry when an agent is suspended due to idle timeout. */
  logSuspend(taskId: string, idleMs: number): Effect.Effect<void, never>
  /**
   * Returns the latest progress timestamp for the most recent activity if that
   * activity has metadata.status === "running" (i.e. a tool is in progress).
   * Falls back to the activity start timestamp when no progress timestamp exists.
   */
  getLastRunningActivityTime(taskId: string): string | null
  /** Log an activity entry when an agent is aborted due to a hung tool. */
  logHungTool(taskId: string, hungMs: number): Effect.Effect<void, never>
  /** Abort the agent process so the health monitor can restart it. */
  abortHungTool(taskId: string): Effect.Effect<void, never>
  /** Persist suspended flag to DB so it survives server restarts. */
  persistSuspended(taskId: string, suspended: boolean): Effect.Effect<void, never>
  /** Complete task when work is done but agent orphaned (e.g. PR exists). */
  completeTask(taskId: string): Effect.Effect<void, Error>
  /** Log activity when auto-completing orphaned task. */
  logOrphanComplete(taskId: string): Effect.Effect<void, never>
  cleanupDeps: CleanupDeps
}

/** Reset the restart counter, hung-tool cooldown, and orphan tracking when the task has real agent activity. */
export function resetRestartCount(taskId: string): void {
  const state = getTaskState(taskId)
  state.consecutiveRestarts = 0
  state.hungToolAbortedAt = undefined
  // Also reset orphan tracking — agent is confirmed working
  resetOrphanState(taskId)
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
    taskLog.debug("Health check", { alive, suspended: state.suspended, reconnecting: state.reconnecting })
    if (!alive) {
      // Skip restart for tasks intentionally suspended due to idle timeout
      if (state.suspended) {
        taskLog.debug("Task suspended (idle), skipping restart")
        return "healthy"
      }

      // Skip when TUI mode owns the session — ACP handle is intentionally removed
      if (state.tuiMode) {
        taskLog.debug("TUI mode active, skipping health check")
        return "healthy"
      }

      // Skip if a reconnect is already in progress — don't count this cycle
      // as a failed restart attempt, since another fiber is handling recovery.
      if (state.reconnecting) {
        taskLog.debug("Reconnect in progress, skipping health check", { taskId: task.id })
        return "healthy"
      }

      // Track orphan state — task has no handle and is not recovering.
      // After multiple checks without recovery, handle as orphaned.
      state.orphanCheckCount += 1
      const now = Date.now()
      const orphanCooldownActive = state.lastOrphanRecoveryAt !== undefined &&
        (now - state.lastOrphanRecoveryAt) < ORPHAN_RECOVERY_COOLDOWN_MS

      // Warn about zombie tasks (no PID tracked in DB) — helps diagnose edge cases
      const taskRow = task as TaskRow & { agent_pid?: number | null; pr_url?: string | null }
      if (!taskRow.agent_pid) {
        taskLog.warn("Running task has no agent_pid in DB", { taskId: task.id, orphanCheckCount: state.orphanCheckCount })
      }

      // Check if task is orphaned (multiple health checks without recovery)
      if (state.orphanCheckCount >= MAX_ORPHAN_CHECKS && !orphanCooldownActive) {
        // Task has been orphaned for too long — try to auto-complete if PR exists
        if (taskRow.pr_url) {
          taskLog.info("Orphaned task has PR, auto-completing", {
            taskId: task.id,
            prUrl: taskRow.pr_url,
            orphanCheckCount: state.orphanCheckCount,
          })
          yield* deps.logOrphanComplete(task.id).pipe(Effect.ignoreLogged)
          yield* deps.completeTask(task.id).pipe(
            Effect.tap(() => Effect.sync(() => {
              clearTaskState(task.id)
            })),
            Effect.catchAll((err) => {
              taskLog.error("Failed to auto-complete orphaned task", { error: String(err) })
              return Effect.void
            }),
          )
          return "healthy"
        }

        // No PR — mark failed after max orphan checks
        taskLog.error("Orphaned task with no PR, marking failed after max orphan checks", {
          taskId: task.id,
          orphanCheckCount: state.orphanCheckCount,
        })
        yield* deps.failTask(task.id, "Agent lost connection and could not be recovered").pipe(Effect.ignoreLogged)
        yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
        yield* clearQueue(task.id)
        clearTaskState(task.id)
        return "failed"
      }

      // Check if the agent reported an error before dying
      const lastError = deps.getLastAgentError(task.id)

      // Fail fast on errors that no restart can fix
      if (lastError && isUnrecoverable(lastError)) {
        taskLog.error("Agent died with unrecoverable error, skipping restart", { error: lastError })
        yield* deps.failTask(task.id, lastError).pipe(Effect.ignoreLogged)
        yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
        yield* clearQueue(task.id)
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
        yield* clearQueue(task.id)
        clearTaskState(task.id)
        return "failed"
      }
      taskLog.warn("Agent not alive, attempting restart", { attempt: restarts, maxAttempts: MAX_CONSECUTIVE_RESTARTS })
      return yield* attemptRestart(task, deps, taskLog, "agent_dead")
    }

    // Agent process is alive, but check if it reported an unrecoverable error.
    // Some ACP agents keep the process alive after API/billing errors, so process
    // health alone is not enough.
    const lastError = deps.getLastAgentError(task.id)
    if (lastError && isUnrecoverable(lastError)) {
      taskLog.error("Agent alive but reported unrecoverable error, marking failed", { error: lastError })
      yield* deps.failTask(task.id, lastError).pipe(Effect.ignoreLogged)
      yield* cleanupSession(task.id, deps.cleanupDeps).pipe(Effect.ignoreLogged)
      yield* clearQueue(task.id)
      clearTaskState(task.id)
      return "failed"
    }

    // Don't reset consecutiveRestarts here — a process that spawns and dies
    // quickly would reset the counter every health check where it's briefly
    // alive, causing infinite restarts. The counter is only reset when the
    // agent completes real work (goes idle → resetRestartCount in start.ts).
    // Clear suspended flag if agent is alive — abort may have only interrupted
    // the current turn without killing the process.
    if (state.suspended) {
      state.suspended = false
      yield* deps.persistSuspended(task.id, false)
    }
    // Reset orphan tracking — agent is alive and healthy
    if (state.orphanCheckCount > 0) {
      resetOrphanState(task.id)
    }
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
  // Record recovery attempt time for orphan cooldown tracking
  const state = getTaskState(task.id)
  state.lastOrphanRecoveryAt = Date.now()

  return deps.restartAgent(task).pipe(
    // restartAgent succeeds → agent process spawned (lifecycle has a 60s startup timeout).
    // Don't reset consecutiveRestarts here — the agent may die again immediately.
    // The counter is only reset in checkTask when the agent is confirmed alive AND stable.
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
        yield* clearQueue(task.id)
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

/**
 * Suspend a running task's agent if it has been idle (no user messages) for
 * longer than DEFAULT_IDLE_TIMEOUT_MS. The task stays "running" — the agent
 * process is killed to free resources and restarted through ACP resume/load on
 * next user message when supported.
 */
function checkIdleTimeout(
  task: TaskRow,
  deps: HealthCheckDeps,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const state = getTaskState(task.id)

    // Already suspended — don't re-log or re-suspend
    if (state.suspended) return

    // Don't suspend while a live turn is still in flight. Raw working can stay
    // true after the stall-aware status flips idle; only bypass suspension when
    // there is active progress or a running tool for the hung-tool watchdog.
    if (deps.isAgentWorkingRaw(task.id)) {
      if (deps.getLastRunningActivityTime(task.id)) return
      if (deps.isAgentWorking(task.id)) return
    }

    const lastMsgTime = deps.getLastUserMessageTime(task.id)
    if (lastMsgTime) {
      const idleMs = Date.now() - parseTaskTimestampMs(lastMsgTime)
      if (idleMs >= DEFAULT_IDLE_TIMEOUT_MS) {
        log.info("Task idle, suspending agent", { taskId: task.id, title: task.title, idleMs })
        state.suspended = true
        yield* deps.suspendAgent(task.id)
        yield* deps.persistSuspended(task.id, true)
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
        yield* deps.persistSuspended(task.id, true)
        yield* deps.logSuspend(task.id, idleMs)
      }
    }
  }).pipe(Effect.catchAll(() => Effect.void))
}

/**
 * Abort a running task's agent if a tool has been in "running" state in the
 * activity log for longer than HUNG_TOOL_TIMEOUT_MS. This catches cases where
 * a tool call (e.g. WebFetch, Bash without timeout) hangs indefinitely.
 *
 * After aborting, the health monitor's dead-process detection will restart the
 * agent automatically on the next cycle, resuming from its existing context.
 * A cooldown prevents re-aborting before the agent has a chance to restart and
 * log fresh activity.
 */
function checkHungTool(
  task: TaskRow,
  deps: HealthCheckDeps,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    // Only relevant when the agent is actively working — if an agent dies before
    // sending a final tool update, stale status:"running" activity can remain.
    // Without this guard a healthy idle agent could be spuriously aborted.
    // Use raw state: stall timeout (2 min) < hung-tool timeout (5 min), so effective
    // state would reset to idle before hung-tool check fires.
    if (!deps.isAgentWorkingRaw(task.id)) return

    const state = getTaskState(task.id)

    // Apply cooldown: after a hung-tool abort the old running tool activity can
    // stay in the DB, so we'd immediately re-trigger without this guard.
    if (state.hungToolAbortedAt !== undefined) {
      if (Date.now() - state.hungToolAbortedAt < HUNG_TOOL_COOLDOWN_MS) return
    }

    const lastRunningAt = deps.getLastRunningActivityTime(task.id)
    if (!lastRunningAt) return

    const hungMs = Date.now() - parseTaskTimestampMs(lastRunningAt)
    if (hungMs < HUNG_TOOL_TIMEOUT_MS) return

    log.warn("Tool hung, aborting agent for restart", { taskId: task.id, title: task.title, hungMs })
    state.hungToolAbortedAt = Date.now()
    yield* deps.logHungTool(task.id, hungMs)
    yield* deps.abortHungTool(task.id)
  }).pipe(Effect.catchAll(() => Effect.void))
}

export function checkAllTasks(
  deps: HealthCheckDeps,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const tasks = yield* deps.listRunningTasks().pipe(
      Effect.catchAll(() => Effect.succeed([] as TaskRow[]))
    )
    log.debug("Health check cycle", { runningTaskCount: tasks.length })

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

      // Idle timeout and hung-tool watchdog: only run when healthy AND not
      // reconnecting. Skip during recovery to avoid incorrectly suspending
      // tasks while a reconnect fiber is still bringing the agent back.
      const taskState = getTaskState(task.id)
      if (result === "healthy" && !taskState.reconnecting) {
        yield* checkIdleTimeout(task, deps)
        yield* checkHungTool(task, deps)
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
