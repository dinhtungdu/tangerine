// Task manager: CRUD operations and state transitions for tasks.
// Logs task creation, cancellation, completion, and prompt queueing for timeline reconstruction.

import { Effect } from "effect"
import { createLogger } from "../logger"
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

const log = createLogger("tasks")

export type TaskSource = "github" | "manual" | "api"

export interface TaskManagerDeps {
  insertTask(task: Pick<TaskRow, "id" | "source" | "repo_url" | "title"> & Partial<Pick<TaskRow, "source_id" | "source_url" | "description" | "user_id" | "branch">>): Effect.Effect<TaskRow, Error>
  updateTask(taskId: string, updates: Partial<Omit<TaskRow, "id">>): Effect.Effect<TaskRow | null, Error>
  getTask(taskId: string): Effect.Effect<TaskRow | null, Error>
  listTasks(filter?: { status?: string }): Effect.Effect<TaskRow[], Error>
  lifecycleDeps: LifecycleDeps
  cleanupDeps: CleanupDeps
  retryDeps: RetryDeps
  projectConfig: ProjectConfig
  credentialConfig: CredentialConfig
  abortAgent(opencodePort: number, sessionId: string): Effect.Effect<void, AgentError>
}

// Prompt queue per task (sent sequentially so agent completes one before starting next)
const promptQueues = new Map<string, string[]>()

export function createTask(
  deps: TaskManagerDeps,
  params: {
    source: TaskSource
    sourceId?: string
    sourceUrl?: string
    repoUrl: string
    title: string
    description?: string
  },
): Effect.Effect<TaskRow, Error> {
  return Effect.gen(function* () {
    const id = crypto.randomUUID()

    const task = yield* deps.insertTask({
      id,
      source: params.source,
      source_id: params.sourceId ?? null,
      source_url: params.sourceUrl ?? null,
      repo_url: params.repoUrl,
      title: params.title,
      description: params.description ?? null,
    })

    log.info("Task created", { taskId: id, source: params.source, title: params.title })

    // Kick off provisioning in a background fiber so task creation is non-blocking
    yield* Effect.fork(
      startSessionWithRetry(task, deps.projectConfig, deps.credentialConfig, deps.lifecycleDeps, deps.retryDeps)
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
      // DB update errors during cancel are non-critical for the cancel flow
      Effect.ignoreLogged
    )

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

export function abortAgent(
  deps: TaskManagerDeps,
  taskId: string,
): Effect.Effect<void, TaskNotFoundError | AgentError> {
  return Effect.gen(function* () {
    const task = yield* deps.getTask(taskId).pipe(
      Effect.mapError(() => new TaskNotFoundError({ taskId }))
    )

    if (!task?.opencode_port || !task.opencode_session_id) {
      log.warn("Abort requested but no active session", { taskId })
      return yield* new TaskNotFoundError({ taskId })
    }

    log.info("Agent aborted", { taskId })
    yield* deps.abortAgent(task.opencode_port, task.opencode_session_id)
  })
}
