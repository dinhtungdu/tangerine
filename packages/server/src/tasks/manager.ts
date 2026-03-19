// Task manager: CRUD operations and state transitions for tasks.
// Logs task creation, cancellation, completion, and prompt queueing for timeline reconstruction.

import { Effect } from "effect"
import { createLogger } from "../logger"
import type { ActivityType } from "@tangerine/shared"
import {
  TaskNotFoundError,
  SessionCleanupError,
  AgentError,
} from "../errors"
import type { TaskRow } from "../db/types"
import type { CredentialConfig, LifecycleDeps, ProjectConfig } from "./lifecycle"
import type { CleanupDeps } from "./cleanup"
import type { RetryDeps } from "./retry"
import { cleanupSession } from "./cleanup"
import { startSessionWithRetry } from "./retry"
import { emitStatusChange } from "./events"

const log = createLogger("tasks")

export type TaskSource = "github" | "manual" | "api"

export interface TaskManagerDeps {
  insertTask(task: Pick<TaskRow, "id" | "project_id" | "source" | "repo_url" | "title"> & Partial<Pick<TaskRow, "source_id" | "source_url" | "description" | "user_id" | "branch" | "provider">>): Effect.Effect<TaskRow, Error>
  updateTask(taskId: string, updates: Partial<Omit<TaskRow, "id">>): Effect.Effect<TaskRow | null, Error>
  getTask(taskId: string): Effect.Effect<TaskRow | null, Error>
  listTasks(filter?: { status?: string; projectId?: string }): Effect.Effect<TaskRow[], Error>
  logActivity(taskId: string, type: ActivityType, event: string, content: string, metadata?: Record<string, unknown>): Effect.Effect<unknown, Error>
  lifecycleDeps: LifecycleDeps
  cleanupDeps: CleanupDeps
  retryDeps: RetryDeps
  getProjectConfig(projectId: string): ProjectConfig | undefined
  credentialConfig: CredentialConfig
  abortAgent(agentPort: number, sessionId: string): Effect.Effect<void, AgentError>
}

// Prompt queue per task (sent sequentially so agent completes one before starting next)
const promptQueues = new Map<string, string[]>()

export function createTask(
  deps: TaskManagerDeps,
  params: {
    source: TaskSource
    projectId: string
    sourceId?: string
    sourceUrl?: string
    title: string
    description?: string
    provider?: string
  },
): Effect.Effect<TaskRow, Error> {
  return Effect.gen(function* () {
    const projectConfig = deps.getProjectConfig(params.projectId)
    if (!projectConfig) {
      return yield* Effect.fail(new Error(`Unknown project: ${params.projectId}`))
    }

    const id = crypto.randomUUID()

    const task = yield* deps.insertTask({
      id,
      project_id: params.projectId,
      source: params.source,
      source_id: params.sourceId ?? null,
      source_url: params.sourceUrl ?? null,
      repo_url: projectConfig.repo,
      title: params.title,
      description: params.description ?? null,
      provider: params.provider ?? "opencode",
    })

    log.info("Task created", { taskId: id, projectId: params.projectId, source: params.source, title: params.title })

    yield* deps.logActivity(id, "lifecycle", "task.created", `Task created: ${params.title}`, {
      source: params.source,
      projectId: params.projectId,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    emitStatusChange(id, task.status)

    // Kick off provisioning as a daemon fiber so it outlives the request scope
    yield* Effect.forkDaemon(
      startSessionWithRetry(task, projectConfig, deps.credentialConfig, deps.lifecycleDeps, deps.retryDeps)
    )

    return task
  })
}

export function cancelTask(
  deps: TaskManagerDeps,
  taskId: string,
): Effect.Effect<void, TaskNotFoundError | SessionCleanupError> {
  return Effect.gen(function* () {
    const task = yield* deps.getTask(taskId).pipe(
      Effect.mapError(() => new TaskNotFoundError({ taskId }))
    )

    if (!task) {
      return yield* new TaskNotFoundError({ taskId })
    }

    log.info("Task cancelled", { taskId })
    yield* deps.updateTask(taskId, {
      status: "cancelled",
      completed_at: new Date().toISOString(),
    }).pipe(
      Effect.ignoreLogged
    )

    yield* deps.logActivity(taskId, "lifecycle", "task.cancelled", "Task cancelled").pipe(
      Effect.catchAll(() => Effect.succeed(undefined))
    )

    emitStatusChange(taskId, "cancelled")

    // Clean up running session if active
    if (task.status === "running" || task.status === "provisioning") {
      yield* cleanupSession(taskId, deps.cleanupDeps).pipe(
        Effect.catchTag("SessionCleanupError", (e) => {
          log.error("Cleanup after cancel failed", {
            taskId,
            error: e.message,
          })
          return Effect.void
        })
      )
    }
  })
}

export function completeTask(
  deps: TaskManagerDeps,
  taskId: string,
): Effect.Effect<void, TaskNotFoundError | SessionCleanupError> {
  return Effect.gen(function* () {
    const task = yield* deps.getTask(taskId).pipe(
      Effect.mapError(() => new TaskNotFoundError({ taskId }))
    )

    if (!task) {
      return yield* new TaskNotFoundError({ taskId })
    }

    const now = new Date().toISOString()
    let durationMs: number | undefined
    if (task.started_at) {
      durationMs = new Date(now).getTime() - new Date(task.started_at).getTime()
    }

    yield* deps.updateTask(taskId, { status: "done", completed_at: now }).pipe(
      Effect.ignoreLogged
    )

    yield* deps.logActivity(taskId, "lifecycle", "task.completed", "Task completed", {
      durationMs,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    emitStatusChange(taskId, "done")
    log.info("Task completed", { taskId, durationMs })

    yield* cleanupSession(taskId, deps.cleanupDeps).pipe(
      Effect.catchTag("SessionCleanupError", (e) => {
        log.error("Cleanup after completion failed", {
          taskId,
          error: e.message,
        })
        return Effect.void
      })
    )
  })
}

export function queuePrompt(taskId: string, prompt: string): void {
  let queue = promptQueues.get(taskId)
  if (!queue) {
    queue = []
    promptQueues.set(taskId, queue)
  }
  queue.push(prompt)
  log.debug("Prompt queued", { taskId, queueLength: queue.length })
}

export function dequeuePrompt(taskId: string): string | undefined {
  const queue = promptQueues.get(taskId)
  if (!queue || queue.length === 0) return undefined
  return queue.shift()
}

/**
 * Resume tasks orphaned by a server restart.
 * Tasks in "created" or "provisioning" status have no running fiber,
 * so we re-dispatch them via startSessionWithRetry.
 */
export function resumeOrphanedTasks(
  deps: TaskManagerDeps,
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const created = yield* deps.listTasks({ status: "created" })
    const provisioning = yield* deps.listTasks({ status: "provisioning" })
    const orphaned = [...created, ...provisioning]

    if (orphaned.length === 0) return 0

    for (const task of orphaned) {
      const projectConfig = deps.getProjectConfig(task.project_id)
      if (!projectConfig) {
        log.warn("Orphaned task has unknown project, marking failed", { taskId: task.id, projectId: task.project_id })
        yield* deps.updateTask(task.id, { status: "failed", error: "Unknown project on resume" }).pipe(Effect.ignoreLogged)
        continue
      }

      log.info("Resuming orphaned task", { taskId: task.id, status: task.status, title: task.title })

      // Reset task state (VM persists per-project, no need to release)
      yield* deps.updateTask(task.id, {
        status: "created",
        agent_session_id: null,
        agent_port: null,
        preview_port: null,
        worktree_path: null,
      }).pipe(Effect.ignoreLogged)

      // Use Effect.forkDaemon so the fiber outlives this Effect scope
      yield* Effect.forkDaemon(
        startSessionWithRetry(task, projectConfig, deps.credentialConfig, deps.lifecycleDeps, deps.retryDeps)
      )
    }

    return orphaned.length
  })
}

export function abortAgent(
  deps: TaskManagerDeps,
  taskId: string,
): Effect.Effect<void, TaskNotFoundError | AgentError> {
  return Effect.gen(function* () {
    const task = yield* deps.getTask(taskId).pipe(
      Effect.mapError(() => new TaskNotFoundError({ taskId }))
    )

    if (!task?.agent_port || !task.agent_session_id) {
      log.warn("Abort requested but no active session", { taskId })
      return yield* new TaskNotFoundError({ taskId })
    }

    log.info("Agent aborted", { taskId })
    yield* deps.abortAgent(task.agent_port, task.agent_session_id)
  })
}
