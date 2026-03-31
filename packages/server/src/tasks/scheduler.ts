// Scheduler: polls for due crons and spawns worker tasks.

import { Effect } from "effect"
import { CronExpressionParser } from "cron-parser"
import { createLogger } from "../logger"
import type { CronRow, TaskRow } from "../db/types"

const log = createLogger("scheduler")

const SCHEDULER_POLL_INTERVAL_MS = 60_000

export interface SchedulerDeps {
  getDueCrons(): Effect.Effect<CronRow[], Error>
  hasActiveCronTask(cronId: string): Effect.Effect<boolean, Error>
  createWorkerFromCron(cron: CronRow): Effect.Effect<TaskRow, Error>
  updateCron(cronId: string, updates: Partial<Omit<CronRow, "id">>): Effect.Effect<CronRow | null, Error>
}

/** Compute the next run time from a cron expression, relative to now. */
export function computeNextRun(cronExpression: string): string {
  const interval = CronExpressionParser.parse(cronExpression)
  return interval.next().toISOString() as string
}

/** Check a single cron and spawn a worker task if due. */
function processCron(
  deps: SchedulerDeps,
  cron: CronRow,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    // Skip if a task from this cron is already active
    const hasActive = yield* deps.hasActiveCronTask(cron.id)
    if (hasActive) {
      log.info("Skipping cron — task already active", { cronId: cron.id })
      const nextRunAt = computeNextRun(cron.cron)
      yield* deps.updateCron(cron.id, { next_run_at: nextRunAt }).pipe(Effect.ignoreLogged)
      return
    }

    log.info("Firing cron", { cronId: cron.id, title: cron.title })

    const task = yield* deps.createWorkerFromCron(cron)

    log.info("Cron spawned worker task", { cronId: cron.id, taskId: task.id })

    // Advance nextRunAt
    const nextRunAt = computeNextRun(cron.cron)
    yield* deps.updateCron(cron.id, { next_run_at: nextRunAt }).pipe(Effect.ignoreLogged)
    log.info("Next run scheduled", { cronId: cron.id, nextRunAt })
  })
}

/** Single poll iteration: find all due crons and process them. */
export function pollCrons(
  deps: SchedulerDeps,
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const dueCrons = yield* deps.getDueCrons()
    if (dueCrons.length === 0) return 0

    log.info("Found due crons", { count: dueCrons.length })

    for (const cron of dueCrons) {
      yield* processCron(deps, cron).pipe(
        Effect.catchAll((err) => {
          log.error("Failed to process cron", { cronId: cron.id, error: String(err) })
          return Effect.void
        })
      )
    }

    return dueCrons.length
  })
}

/** Start the scheduler polling loop. Returns a cleanup function to stop it. */
export function startScheduler(deps: SchedulerDeps): { stop: () => void } {
  log.info("Scheduler started", { intervalMs: SCHEDULER_POLL_INTERVAL_MS })

  const timer = setInterval(() => {
    Effect.runPromise(
      pollCrons(deps).pipe(
        Effect.catchAll((err) => {
          log.error("Scheduler poll failed", { error: String(err) })
          return Effect.succeed(0)
        })
      )
    )
  }, SCHEDULER_POLL_INTERVAL_MS)

  // Run immediately on startup to catch any crons that became due while server was down
  Effect.runPromise(
    pollCrons(deps).pipe(
      Effect.catchAll((err) => {
        log.error("Initial scheduler poll failed", { error: String(err) })
        return Effect.succeed(0)
      })
    )
  )

  return {
    stop: () => {
      clearInterval(timer)
      log.info("Scheduler stopped")
    },
  }
}
