// Scheduler: polls for due scheduled tasks and spawns worker children.

import { Effect } from "effect"
import { CronExpressionParser } from "cron-parser"
import { createLogger } from "../logger"
import type { TaskRow } from "../db/types"
import type { ActivityType } from "@tangerine/shared"

const log = createLogger("scheduler")

const SCHEDULER_POLL_INTERVAL_MS = 60_000

export interface SchedulerDeps {
  getDueScheduledTasks(): Effect.Effect<TaskRow[], Error>
  getChildTasks(parentTaskId: string): Effect.Effect<TaskRow[], Error>
  createChildWorker(scheduled: TaskRow): Effect.Effect<TaskRow, Error>
  updateTask(taskId: string, updates: Partial<Omit<TaskRow, "id">>): Effect.Effect<TaskRow | null, Error>
  logActivity(taskId: string, type: ActivityType, event: string, content: string, metadata?: Record<string, unknown>): Effect.Effect<unknown, Error>
}

/** Compute the next run time from a cron expression, relative to now. */
export function computeNextRun(cronExpression: string): string {
  const interval = CronExpressionParser.parse(cronExpression)
  return interval.next().toISOString() as string
}

/** Check a single scheduled task and spawn a child worker if due. */
function processScheduledTask(
  deps: SchedulerDeps,
  task: TaskRow,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    // Skip if a child worker is already running for this scheduled task
    const children = yield* deps.getChildTasks(task.id)
    const hasActiveChild = children.some(
      (c) => c.status === "created" || c.status === "provisioning" || c.status === "running"
    )
    if (hasActiveChild) {
      log.info("Skipping scheduled task — child already active", { taskId: task.id })
      // Still advance next_run_at so we don't re-trigger every poll
      if (task.cron_expression) {
        const nextRunAt = computeNextRun(task.cron_expression!)
        yield* deps.updateTask(task.id, { next_run_at: nextRunAt }).pipe(Effect.ignoreLogged)
      }
      return
    }

    log.info("Firing scheduled task", { taskId: task.id, title: task.title })

    // Spawn a worker child
    const child = yield* deps.createChildWorker(task)

    yield* deps.logActivity(task.id, "lifecycle", "schedule.fired", `Spawned worker child: ${child.id}`, {
      childTaskId: child.id,
    }).pipe(Effect.catchAll(() => Effect.void))

    // Advance next_run_at
    if (task.cron_expression) {
      const nextRunAt = computeNextRun(task.cron_expression!)
      yield* deps.updateTask(task.id, { next_run_at: nextRunAt }).pipe(Effect.ignoreLogged)
      log.info("Next run scheduled", { taskId: task.id, nextRunAt })
    }
  })
}

/** Single poll iteration: find all due scheduled tasks and process them. */
export function pollScheduledTasks(
  deps: SchedulerDeps,
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const dueTasks = yield* deps.getDueScheduledTasks()
    if (dueTasks.length === 0) return 0

    log.info("Found due scheduled tasks", { count: dueTasks.length })

    for (const task of dueTasks) {
      yield* processScheduledTask(deps, task).pipe(
        Effect.catchAll((err) => {
          log.error("Failed to process scheduled task", { taskId: task.id, error: String(err) })
          return Effect.void
        })
      )
    }

    return dueTasks.length
  })
}

/** Start the scheduler polling loop. Returns a cleanup function to stop it. */
export function startScheduler(deps: SchedulerDeps): { stop: () => void } {
  log.info("Scheduler started", { intervalMs: SCHEDULER_POLL_INTERVAL_MS })

  const timer = setInterval(() => {
    Effect.runPromise(
      pollScheduledTasks(deps).pipe(
        Effect.catchAll((err) => {
          log.error("Scheduler poll failed", { error: String(err) })
          return Effect.succeed(0)
        })
      )
    )
  }, SCHEDULER_POLL_INTERVAL_MS)

  // Run immediately on startup to catch any tasks that became due while server was down
  Effect.runPromise(
    pollScheduledTasks(deps).pipe(
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
