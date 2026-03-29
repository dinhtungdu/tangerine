// Task manager: CRUD operations and state transitions for tasks.
// v1: No VM management — agents run as local processes.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { type ActivityType, ORCHESTRATOR_TASK_NAME } from "@tangerine/shared"
import {
  TaskNotFoundError,
  SessionCleanupError,
  AgentError,
} from "../errors"
import type { TaskRow } from "../db/types"
import type { LifecycleDeps, ProjectConfig } from "./lifecycle"
import type { CleanupDeps } from "./cleanup"
import type { RetryDeps } from "./retry"
import { cleanupSession } from "./cleanup"
import { startSessionWithRetry, reconnectSessionWithRetry } from "./retry"
import { emitStatusChange, clearAgentWorkingState } from "./events"
import { deletePoolForProject, reconcileStaleSlots } from "./worktree-pool"

const log = createLogger("tasks")

/** Create a per-task copy of lifecycleDeps with the correct agent factory.
 *  Avoids mutating the shared deps object — safe for concurrent tasks with different providers. */
function depsForProvider(deps: TaskManagerDeps, provider: string): LifecycleDeps {
  if (!deps.getAgentFactory) return deps.lifecycleDeps
  return { ...deps.lifecycleDeps, agentFactory: deps.getAgentFactory(provider) }
}

export type TaskSource = "github" | "manual" | "api" | "cross-project"

export interface TaskManagerDeps {
  insertTask(task: Pick<TaskRow, "id" | "project_id" | "source" | "repo_url" | "title"> & Partial<Pick<TaskRow, "source_id" | "source_url" | "description" | "user_id" | "branch" | "provider" | "model" | "reasoning_effort" | "parent_task_id">>): Effect.Effect<TaskRow, Error>
  updateTask(taskId: string, updates: Partial<Omit<TaskRow, "id">>): Effect.Effect<TaskRow | null, Error>
  getTask(taskId: string): Effect.Effect<TaskRow | null, Error>
  listTasks(filter?: { status?: string; projectId?: string }): Effect.Effect<TaskRow[], Error>
  logActivity(taskId: string, type: ActivityType, event: string, content: string, metadata?: Record<string, unknown>): Effect.Effect<unknown, Error>
  lifecycleDeps: LifecycleDeps
  cleanupDeps: CleanupDeps
  retryDeps: RetryDeps
  getProjectConfig(projectId: string): ProjectConfig | undefined
  abortAgent(taskId: string): Effect.Effect<void, AgentError>
  /** Select the correct agent factory for a given provider type */
  getAgentFactory?: (provider: string) => import("../agent/provider").AgentFactory
}

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
    model?: string
    reasoningEffort?: string
    branch?: string
    parentTaskId?: string
  },
): Effect.Effect<TaskRow, Error> {
  return Effect.gen(function* () {
    const projectConfig = deps.getProjectConfig(params.projectId)
    if (!projectConfig) {
      return yield* Effect.fail(new Error(`Unknown project: ${params.projectId}`))
    }

    // Enforce one orchestrator per project
    if (params.title === ORCHESTRATOR_TASK_NAME) {
      const allTasks = yield* deps.listTasks({ projectId: params.projectId })
      const active = allTasks.find(
        (t) => t.title === ORCHESTRATOR_TASK_NAME && !["done", "failed", "cancelled"].includes(t.status)
      )
      if (active) {
        return yield* Effect.fail(
          new Error(`Project ${params.projectId} already has an active orchestrator task: ${active.id}`)
        )
      }
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
      model: params.model ?? null,
      reasoning_effort: params.reasoningEffort ?? null,
      branch: params.branch ?? null,
      parent_task_id: params.parentTaskId ?? null,
    })

    log.info("Task created", { taskId: id, projectId: params.projectId, source: params.source, title: params.title })

    yield* deps.logActivity(id, "lifecycle", "task.created", `Task created: ${params.title}`, {
      source: params.source,
      projectId: params.projectId,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    emitStatusChange(id, task.status)

    // Orchestrator tasks are started on-demand (when the user enters the chat),
    // not immediately on creation. All other tasks auto-provision.
    if (params.title !== ORCHESTRATOR_TASK_NAME) {
      const taskLifecycleDeps = depsForProvider(deps, params.provider ?? "opencode")
      yield* Effect.forkDaemon(
        startSessionWithRetry(task, projectConfig, taskLifecycleDeps, deps.retryDeps)
      )
    }

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

    clearAgentWorkingState(taskId)
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

    clearAgentWorkingState(taskId)
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

/**
 * Resume tasks orphaned by a server restart.
 * - "created"/"provisioning" tasks: full restart via startSessionWithRetry
 * - "running" tasks: lightweight reconnect by checking PIDs
 */
export function resumeOrphanedTasks(
  deps: TaskManagerDeps,
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const created = yield* deps.listTasks({ status: "created" })
    const provisioning = yield* deps.listTasks({ status: "provisioning" })
    const running = yield* deps.listTasks({ status: "running" })

    const needsFullRestart = [...created, ...provisioning]
    const needsReconnect = running

    const total = needsFullRestart.length + needsReconnect.length
    if (total === 0) return 0

    // Reconcile stale worktree slots before resuming
    const allProjectIds = new Set([...needsFullRestart, ...needsReconnect].map((t) => t.project_id).filter(Boolean))
    for (const projectId of allProjectIds) {
      yield* reconcileStaleSlots(deps.lifecycleDeps.db, projectId, deps.getTask).pipe(Effect.ignoreLogged)
    }

    for (const task of needsFullRestart) {
      const projectConfig = deps.getProjectConfig(task.project_id)
      if (!projectConfig) {
        log.warn("Orphaned task has unknown project, marking failed", { taskId: task.id, projectId: task.project_id })
        yield* deps.updateTask(task.id, { status: "failed", error: "Unknown project on resume" }).pipe(Effect.ignoreLogged)
        continue
      }

      log.info("Resuming orphaned task", { taskId: task.id, status: task.status, title: task.title })

      const taskLifecycleDeps = depsForProvider(deps, task.provider)

      // Reset task state
      yield* deps.updateTask(task.id, {
        status: "created",
        agent_session_id: null,
        agent_pid: null,
        worktree_path: null,
      }).pipe(Effect.ignoreLogged)

      yield* Effect.forkDaemon(
        startSessionWithRetry(task, projectConfig, taskLifecycleDeps, deps.retryDeps)
      )
    }

    for (const task of needsReconnect) {
      const projectConfig = deps.getProjectConfig(task.project_id)
      if (!projectConfig) {
        log.warn("Running task has unknown project, marking failed", { taskId: task.id })
        yield* deps.updateTask(task.id, { status: "failed", error: "Unknown project on reconnect" }).pipe(Effect.ignoreLogged)
        continue
      }

      log.info("Reconnecting running task", { taskId: task.id, provider: task.provider, title: task.title })

      const taskLifecycleDeps = depsForProvider(deps, task.provider)

      // Lock BEFORE forking — the forked fiber may not start before the health
      // monitor's first check runs. reconnectSessionWithRetry releases the lock
      // on completion via unlockReconnect.
      deps.retryDeps.lockReconnect?.(task.id)
      yield* Effect.forkDaemon(
        reconnectSessionWithRetry(task, projectConfig, taskLifecycleDeps, deps.retryDeps)
      )
    }

    return total
  })
}

/**
 * Change model/reasoning config for a running task.
 * Tries hot-swap via handle.updateConfig() first (works for OpenCode).
 * Falls back to shutdown + restart with --resume (needed for Claude Code).
 */
export function changeConfig(
  deps: TaskManagerDeps,
  taskId: string,
  config: { model?: string; reasoningEffort?: string },
): Effect.Effect<void, TaskNotFoundError | Error> {
  return Effect.gen(function* () {
    const task = yield* deps.getTask(taskId).pipe(
      Effect.mapError(() => new TaskNotFoundError({ taskId }))
    )
    if (!task) return yield* new TaskNotFoundError({ taskId })
    if (task.status !== "running") {
      return yield* Effect.fail(new Error(`Task ${taskId} is not running (status: ${task.status})`))
    }

    const projectConfig = deps.getProjectConfig(task.project_id)
    if (!projectConfig) {
      return yield* Effect.fail(new Error(`Unknown project: ${task.project_id}`))
    }

    const modelChanged = config.model && config.model !== task.model
    const effortChanged = config.reasoningEffort && config.reasoningEffort !== task.reasoning_effort
    if (!modelChanged && !effortChanged) return

    log.info("Changing task config", { taskId, model: modelChanged ? { from: task.model, to: config.model } : undefined, reasoningEffort: effortChanged ? { from: task.reasoning_effort, to: config.reasoningEffort } : undefined })

    const handle = deps.cleanupDeps.getAgentHandle(taskId)

    // Try hot-swap — provider applies changes without restart
    if (handle?.updateConfig) {
      const applied = yield* handle.updateConfig({
        model: modelChanged ? config.model : undefined,
        reasoningEffort: effortChanged ? config.reasoningEffort : undefined,
      }).pipe(Effect.catchAll(() => Effect.succeed(false)))

      if (applied) {
        const updates: Partial<import("../db/types").TaskRow> = {}
        if (modelChanged) updates.model = config.model!
        if (effortChanged) updates.reasoning_effort = config.reasoningEffort!
        yield* deps.updateTask(taskId, updates).pipe(Effect.ignoreLogged)

        yield* logConfigChange(deps, taskId, config, task)
        return
      }
    }

    // Fallback: restart agent process with new config
    // Only resume session if the agent actually had a conversation — otherwise
    // --resume wastes time on a nonexistent session file and falls back to fresh.
    const hasAssistantResponse = deps.cleanupDeps.db.prepare(
      "SELECT 1 FROM session_logs WHERE task_id = ? AND role IN ('assistant', 'narration') LIMIT 1"
    ).get(taskId)
    const sessionId = hasAssistantResponse ? task.agent_session_id : null
    if (handle) {
      yield* handle.shutdown()
    }

    const updates: Partial<import("../db/types").TaskRow> = {}
    if (modelChanged) updates.model = config.model!
    if (effortChanged) updates.reasoning_effort = config.reasoningEffort!
    yield* deps.updateTask(taskId, updates).pipe(Effect.ignoreLogged)

    const updatedTask = yield* deps.getTask(taskId).pipe(
      Effect.flatMap((t) => t ? Effect.succeed(t) : Effect.fail(new Error("Task disappeared")))
    )

    yield* logConfigChange(deps, taskId, config, task)

    const taskLifecycleDeps = depsForProvider(deps, updatedTask.provider)
    const taskWithSession = { ...updatedTask, agent_session_id: sessionId }
    yield* Effect.forkDaemon(
      reconnectSessionWithRetry(taskWithSession, projectConfig, taskLifecycleDeps, deps.retryDeps)
    )
  })
}

function logConfigChange(
  deps: TaskManagerDeps,
  taskId: string,
  config: { model?: string; reasoningEffort?: string },
  prev: import("../db/types").TaskRow,
) {
  const changes = [
    config.model && config.model !== prev.model && `model -> ${config.model}`,
    config.reasoningEffort && config.reasoningEffort !== prev.reasoning_effort && `reasoning -> ${config.reasoningEffort}`,
  ].filter(Boolean).join(", ")
  return deps.logActivity(taskId, "lifecycle", "config.changed", changes, {
    model: config.model ?? prev.model,
    reasoningEffort: config.reasoningEffort ?? prev.reasoning_effort,
  }).pipe(Effect.catchAll(() => Effect.void))
}

export function abortAgent(
  deps: TaskManagerDeps,
  taskId: string,
): Effect.Effect<void, TaskNotFoundError | AgentError> {
  return Effect.gen(function* () {
    const task = yield* deps.getTask(taskId).pipe(
      Effect.mapError(() => new TaskNotFoundError({ taskId }))
    )

    if (!task) {
      return yield* new TaskNotFoundError({ taskId })
    }

    log.info("Agent aborted", { taskId })
    yield* deps.abortAgent(taskId)
  })
}

/**
 * Reprovision tasks after a project rebuild.
 * Tasks with a remote branch are reset to "created" for reprovisioning.
 * Tasks without a remote branch are marked "failed" (work is lost).
 */
export function reprovisionTasksForProject(
  deps: TaskManagerDeps,
  projectId: string,
  checkRemoteBranch?: (branch: string) => Effect.Effect<boolean, Error>,
): Effect.Effect<{ reprovisioned: number; failed: number }, Error> {
  return Effect.gen(function* () {
    const allTasks = yield* deps.listTasks({})
    const affected = allTasks.filter(
      (t) => t.project_id === projectId
        && !["done", "cancelled"].includes(t.status)
        && t.title !== ORCHESTRATOR_TASK_NAME
    )

    if (affected.length === 0) return { reprovisioned: 0, failed: 0 }

    // Delete pool slots for the project
    yield* deletePoolForProject(deps.lifecycleDeps.db, projectId).pipe(Effect.ignoreLogged)

    let reprovisioned = 0
    let failed = 0

    for (const task of affected) {
      if (task.branch && checkRemoteBranch) {
        const exists = yield* checkRemoteBranch(task.branch).pipe(
          Effect.catchAll(() => Effect.succeed(false))
        )

        if (!exists) {
          yield* deps.updateTask(task.id, {
            status: "failed",
            error: "Project rebuilt — branch was not pushed to remote, work is lost",
          }).pipe(Effect.ignoreLogged)
          yield* deps.logActivity(task.id, "lifecycle", "task.failed",
            `Task failed: branch ${task.branch} not found on remote after rebuild`
          ).pipe(Effect.catchAll(() => Effect.void))
          clearAgentWorkingState(task.id)
          emitStatusChange(task.id, "failed")
          failed++
          continue
        }
      }

      // Reset for reprovisioning
      yield* deps.updateTask(task.id, {
        status: "created",
        agent_session_id: null,
        agent_pid: null,
        worktree_path: null,
      }).pipe(Effect.ignoreLogged)
      yield* deps.logActivity(task.id, "lifecycle", "task.reprovisioning",
        "Task reset for reprovisioning after rebuild"
      ).pipe(Effect.catchAll(() => Effect.void))
      emitStatusChange(task.id, "created")
      reprovisioned++
    }

    log.info("Tasks reprovisioned after rebuild", { projectId, reprovisioned, failed })
    return { reprovisioned, failed }
  })
}

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"])

/**
 * Ensure an orchestrator task exists for a project. Lazy creation:
 * - Active orchestrator exists → return it
 * - Terminal orchestrator exists → create new one linked via parent_task_id
 * - No orchestrator exists → create one
 * Does NOT start the session — call startTask() when the user enters the chat.
 */
export function ensureOrchestrator(
  deps: TaskManagerDeps,
  projectId: string,
  provider?: string,
): Effect.Effect<TaskRow, Error> {
  return Effect.gen(function* () {
    const allTasks = yield* deps.listTasks({ projectId })

    // Find active orchestrator (non-terminal)
    const active = allTasks.find(
      (t) => t.title === ORCHESTRATOR_TASK_NAME && !TERMINAL_STATUSES.has(t.status)
    )
    if (active) return active

    // Find most recent terminal orchestrator for parent linkage
    const prevOrchestrators = allTasks
      .filter((t) => t.title === ORCHESTRATOR_TASK_NAME && TERMINAL_STATUSES.has(t.status))
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    const terminal = prevOrchestrators[0]

    const task = yield* createTask(deps, {
      source: "manual",
      projectId,
      title: ORCHESTRATOR_TASK_NAME,
      provider,
      parentTaskId: terminal?.id,
    })

    return task
  })
}

/**
 * Start a session for a task that's in "created" status (on-demand start).
 * Used for orchestrator tasks that are created dormant.
 */
export function startTask(
  deps: TaskManagerDeps,
  taskId: string,
): Effect.Effect<void, TaskNotFoundError | Error> {
  return Effect.gen(function* () {
    const task = yield* deps.getTask(taskId).pipe(
      Effect.mapError(() => new TaskNotFoundError({ taskId }))
    )
    if (!task) return yield* new TaskNotFoundError({ taskId })

    if (task.status !== "created") {
      // Already started or terminal — nothing to do
      return
    }

    const projectConfig = deps.getProjectConfig(task.project_id)
    if (!projectConfig) {
      return yield* Effect.fail(new Error(`Unknown project: ${task.project_id}`))
    }

    log.info("Starting task on demand", { taskId, title: task.title })
    const taskLifecycleDeps = depsForProvider(deps, task.provider)
    yield* Effect.forkDaemon(
      startSessionWithRetry(task, projectConfig, taskLifecycleDeps, deps.retryDeps)
    )
  })
}
