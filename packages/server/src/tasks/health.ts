// Health checker: periodically verifies running tasks are alive.
// Logs each check so recovery actions are traceable.

import { Effect, Schedule } from "effect"
import { createLogger } from "../logger"
import { HealthCheckError } from "../errors"
import type { TaskRow } from "../db/types"

const log = createLogger("health")

const HEALTH_CHECK_INTERVAL_MS = 30_000

export interface HealthCheckDeps {
  listRunningTasks(): Effect.Effect<TaskRow[], Error>
  checkAgentHealth(agentPort: number): Effect.Effect<boolean, never>
  checkVmHealth(vmId: string): Effect.Effect<boolean, never>
  restartOpencode(task: TaskRow): Effect.Effect<void, import("../errors").SshError>
  failTask(taskId: string, reason: string): Effect.Effect<void, Error>
}

export function checkTask(
  task: TaskRow,
  deps: HealthCheckDeps,
): Effect.Effect<"healthy" | "recovered" | "failed", HealthCheckError> {
  return Effect.gen(function* () {
    const taskLog = log.child({ taskId: task.id, vmId: task.vm_id })

    // Check VM is still reachable
    if (task.vm_id) {
      const vmAlive = yield* deps.checkVmHealth(task.vm_id)
      if (!vmAlive) {
        taskLog.warn("Task unhealthy, recovering", { reason: "vm-unreachable" })
        taskLog.error("Recovery failed, marking task failed", {
          reason: "VM is unreachable, cannot recover",
        })
        yield* deps.failTask(task.id, "VM became unreachable").pipe(Effect.ignoreLogged)
        return yield* new HealthCheckError({
          message: "VM became unreachable",
          taskId: task.id,
          reason: "vm_dead",
        })
      }
    }

    // Check OpenCode server is responding
    if (task.agent_port) {
      const healthy = yield* deps.checkAgentHealth(task.agent_port)
      if (!healthy) {
        taskLog.warn("Task unhealthy, recovering", { reason: "opencode-unresponsive" })

        const restartResult = yield* deps.restartOpencode(task).pipe(
          Effect.map(() => "recovered" as const),
          Effect.catchAll((err) => {
            taskLog.error("Recovery failed, marking task failed", {
              reason: err.message,
            })
            return Effect.gen(function* () {
              yield* deps.failTask(task.id, "OpenCode server unresponsive and restart failed").pipe(
                Effect.ignoreLogged
              )
              return "failed" as const
            })
          })
        )

        if (restartResult === "recovered") {
          taskLog.info("Recovery succeeded", { action: "opencode-restart" })
          return "recovered"
        }

        return yield* new HealthCheckError({
          message: "OpenCode server unresponsive and restart failed",
          taskId: task.id,
          reason: "opencode_dead",
        })
      }
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
    // Run in background fiber so caller isn't blocked
    Effect.fork,
    Effect.asVoid,
  )
}
