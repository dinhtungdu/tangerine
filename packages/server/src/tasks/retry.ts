// Retry wrapper using Effect.retry with exponential backoff.

import { Effect, Schedule } from "effect"
import { createLogger } from "../logger"

import type { TaskRow } from "../db/types"
import type { LifecycleDeps, ProjectConfig, SessionInfo } from "./lifecycle"
import type { CleanupDeps } from "./cleanup"
import { startSession, reconnectSession } from "./lifecycle"
import { cleanupSession } from "./cleanup"

const log = createLogger("retry")

const MAX_RETRY_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// Shared retry schedules — reusable across session, prompt, and HTTP retries
// ---------------------------------------------------------------------------

/** Exponential backoff: 1s, 2s, 4s… capped at `maxAttempts` retries. */
export function exponentialSchedule(maxAttempts: number) {
  return Schedule.exponential("1 second").pipe(
    Schedule.compose(Schedule.recurs(maxAttempts - 1))
  )
}

/** Short backoff for transient failures: 500ms, 1s — 2 retries by default. */
export function transientSchedule(maxAttempts = 2) {
  return Schedule.exponential("500 millis").pipe(
    Schedule.compose(Schedule.recurs(maxAttempts - 1))
  )
}

export interface RetryDeps {
  updateTask(taskId: string, updates: Partial<TaskRow>): Effect.Effect<void, Error>
  onSessionReady?(taskId: string, session: SessionInfo): void
  /** Set by callers before forking reconnectSessionWithRetry to prevent duplicate reconnects. */
  lockReconnect?(taskId: string): void
  /** Called by reconnectSessionWithRetry on completion (success or failure) to release the reconnect lock. */
  unlockReconnect?(taskId: string): void
  cleanupDeps: CleanupDeps
}

export function startSessionWithRetry(
  task: TaskRow,
  config: ProjectConfig,
  lifecycleDeps: LifecycleDeps,
  retryDeps: RetryDeps,
): Effect.Effect<void, never> {
  let attempt = 0
  return startSession(task, config, lifecycleDeps).pipe(
    Effect.tap((session) =>
      Effect.sync(() => {
        retryDeps.onSessionReady?.(task.id, session)
      })
    ),
    Effect.asVoid,
    Effect.tapError(() =>
      cleanupSession(task.id, retryDeps.cleanupDeps).pipe(
        Effect.tap(() => Effect.sync(() => {
          attempt++
          log.info("Cleaned up before retry", { taskId: task.id, attempt })
        })),
        Effect.ignoreLogged,
      )
    ),
    Effect.retry(exponentialSchedule(MAX_RETRY_ATTEMPTS)),
    Effect.tapError((error) =>
      Effect.sync(() => {
        log.error("All retries exhausted", {
          taskId: task.id,
          attempts: MAX_RETRY_ATTEMPTS,
          lastError: error.message,
        })
      })
    ),
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        yield* retryDeps.updateTask(task.id, { status: "failed" }).pipe(Effect.ignoreLogged)
        yield* retryDeps.updateTask(task.id, {
          error: `Failed after ${MAX_RETRY_ATTEMPTS} attempts: ${error.message}`,
        }).pipe(Effect.ignoreLogged)
        yield* cleanupSession(task.id, retryDeps.cleanupDeps).pipe(Effect.ignoreLogged)
      })
    )
  )
}

/** Reconnect an orphaned running task — skips worktree/setup, just restarts agent.
 *  Callers that fork this effect should set their reconnect lock BEFORE forking
 *  (since the fiber may not start before other subsystems observe the task).
 *  This function always releases the lock on completion via unlockReconnect. */
export function reconnectSessionWithRetry(
  task: TaskRow,
  config: ProjectConfig,
  lifecycleDeps: LifecycleDeps,
  retryDeps: RetryDeps,
): Effect.Effect<void, never> {
  return reconnectSession(task, config, lifecycleDeps).pipe(
    Effect.tap((session) =>
      Effect.sync(() => {
        retryDeps.onSessionReady?.(task.id, session)
      })
    ),
    Effect.asVoid,
    Effect.tapError(() =>
      cleanupSession(task.id, retryDeps.cleanupDeps).pipe(Effect.ignoreLogged)
    ),
    Effect.retry(exponentialSchedule(MAX_RETRY_ATTEMPTS)),
    Effect.tapError((error) =>
      Effect.sync(() => {
        log.error("Reconnect retries exhausted", {
          taskId: task.id,
          attempts: MAX_RETRY_ATTEMPTS,
          lastError: error.message,
        })
      })
    ),
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        yield* retryDeps.updateTask(task.id, { status: "failed" }).pipe(Effect.ignoreLogged)
        yield* retryDeps.updateTask(task.id, {
          error: `Reconnect failed after ${MAX_RETRY_ATTEMPTS} attempts: ${error.message}`,
        }).pipe(Effect.ignoreLogged)
        yield* cleanupSession(task.id, retryDeps.cleanupDeps).pipe(Effect.ignoreLogged)
      })
    ),
    Effect.ensuring(Effect.sync(() => retryDeps.unlockReconnect?.(task.id))),
  )
}
