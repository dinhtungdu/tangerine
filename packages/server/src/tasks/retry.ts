// Retry wrapper using Effect.retry with exponential backoff.
// Logs each attempt so failures can be diagnosed from the timeline.

import { Effect, Schedule } from "effect"
import { createLogger } from "../logger"
import { SessionStartError } from "../errors"
import type { TaskRow } from "../db/types"
import type { CredentialConfig, LifecycleDeps, ProjectConfig } from "./lifecycle"
import { startSession } from "./lifecycle"

const log = createLogger("retry")

const MAX_RETRY_ATTEMPTS = 3

export interface RetryDeps {
  updateTask(taskId: string, updates: Partial<TaskRow>): Effect.Effect<void, Error>
}

export function startSessionWithRetry(
  task: TaskRow,
  config: ProjectConfig,
  creds: CredentialConfig,
  lifecycleDeps: LifecycleDeps,
  retryDeps: RetryDeps,
): Effect.Effect<void, never> {
  return startSession(task, config, creds, lifecycleDeps).pipe(
    // Discard the SessionInfo on success since callers only care about side effects
    Effect.asVoid,
    Effect.retry(
      Schedule.exponential("1 second").pipe(
        Schedule.compose(Schedule.recurs(MAX_RETRY_ATTEMPTS - 1))
      )
    ),
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
      // After all retries exhausted, mark task as failed
      Effect.gen(function* () {
        yield* retryDeps.updateTask(task.id, { status: "failed" }).pipe(Effect.ignoreLogged)
        yield* retryDeps.updateTask(task.id, {
          error: `Failed after ${MAX_RETRY_ATTEMPTS} attempts: ${error.message}`,
        }).pipe(Effect.ignoreLogged)
      })
    )
  )
}
