// Task manager: CRUD operations and state transitions for tasks.
// v1: No VM management — agents run as local processes.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { type ActivityType, type TaskType, type TaskCapability, DEFAULT_PROVIDER, ORCHESTRATOR_TASK_NAME, TERMINAL_STATUSES } from "@tangerine/shared"
import {
  TaskNotFoundError,
  TaskNotTerminalError,
  SessionCleanupError,
  AgentError,
  DbError,
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

export type TaskSource = "github" | "manual" | "api" | "cross-project" | "cron"

export interface TaskManagerDeps {
  insertTask(task: Pick<TaskRow, "id" | "project_id" | "source" | "repo_url" | "title"> & Partial<Pick<TaskRow, "source_id" | "source_url" | "type" | "description" | "user_id" | "branch" | "provider" | "model" | "reasoning_effort" | "parent_task_id" | "capabilities">>): Effect.Effect<TaskRow, Error>
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
    type?: TaskType
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

    if (projectConfig.archived) {
      return yield* Effect.fail(new Error(`Project "${params.projectId}" is archived — unarchive it before creating tasks`))
    }

    // Enforce one orchestrator per project
    const taskType: TaskType = params.type ?? "worker"
    if (taskType === "orchestrator") {
      const allTasks = yield* deps.listTasks({ projectId: params.projectId })
      const active = allTasks.find(
        (t) => t.type === "orchestrator" && !["done", "failed", "cancelled"].includes(t.status)
      )
      if (active) {
        return yield* Effect.fail(
          new Error(`Project ${params.projectId} already has an active orchestrator task: ${active.id}`)
        )
      }
    }

    const id = crypto.randomUUID()
    const resolvedProvider = params.provider ?? projectConfig.defaultProvider ?? DEFAULT_PROVIDER

    const description = params.description ?? null

    const capabilities: TaskCapability[] = taskType === "orchestrator"
      ? ["resolve", "predefined-prompts"]
      : taskType === "reviewer"
        ? ["resolve", "predefined-prompts", "diff"]
        : ["resolve", "predefined-prompts", "diff", "continue"]

    const task = yield* deps.insertTask({
      id,
      project_id: params.projectId,
      source: params.source,
      source_id: params.sourceId ?? null,
      source_url: params.sourceUrl ?? null,
      repo_url: projectConfig.repo,
      title: params.title,
      type: taskType,
      description,
      provider: resolvedProvider,
      model: params.model ?? null,
      reasoning_effort: params.reasoningEffort ?? null,
      branch: params.branch ?? null,
      parent_task_id: params.parentTaskId ?? null,
      capabilities: JSON.stringify(capabilities),
    })

    log.info("Task created", { taskId: id, projectId: params.projectId, source: params.source, title: params.title })

    yield* deps.logActivity(id, "lifecycle", "task.created", `Task created: ${params.title}`, {
      source: params.source,
      projectId: params.projectId,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    emitStatusChange(id, task.status)

    // Orchestrator tasks are not auto-started — started on-demand when the user enters the chat.
    if (taskType !== "orchestrator") {
      const taskLifecycleDeps = depsForProvider(deps, resolvedProvider)
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
): Effect.Effect<void, TaskNotFoundError | SessionCleanupError | DbError> {
  return Effect.gen(function* () {
    const task = yield* deps.getTask(taskId).pipe(
      Effect.mapError(() => new TaskNotFoundError({ taskId }))
    )

    if (!task) {
      return yield* new TaskNotFoundError({ taskId })
    }

    log.info("Task cancelled", { taskId })
    const dbError = yield* deps.updateTask(taskId, {
      status: "cancelled",
      completed_at: new Date().toISOString(),
    }).pipe(
      Effect.map(() => null as DbError | null),
      Effect.catchAll((cause) => {
        const err = new DbError({ message: `Failed to persist cancelled status for task ${taskId}`, cause })
        log.error(err.message, { taskId, cause: String(cause) })
        return Effect.succeed(err)
      })
    )

    yield* deps.logActivity(taskId, "lifecycle", "task.cancelled", "Task cancelled").pipe(
      Effect.catchAll(() => Effect.succeed(undefined))
    )

    clearAgentWorkingState(taskId)
    emitStatusChange(taskId, "cancelled")

    // Always clean up — even if the status write failed
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

    if (dbError) return yield* dbError
  })
}

export function completeTask(
  deps: TaskManagerDeps,
  taskId: string,
): Effect.Effect<void, TaskNotFoundError | SessionCleanupError | DbError> {
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

    const dbError = yield* deps.updateTask(taskId, { status: "done", completed_at: now }).pipe(
      Effect.map(() => null as DbError | null),
      Effect.catchAll((cause) => {
        const err = new DbError({ message: `Failed to persist done status for task ${taskId}`, cause })
        log.error(err.message, { taskId, cause: String(cause) })
        return Effect.succeed(err)
      })
    )

    yield* deps.logActivity(taskId, "lifecycle", "task.completed", "Task completed", {
      durationMs,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    clearAgentWorkingState(taskId)
    emitStatusChange(taskId, "done")
    log.info("Task completed", { taskId, durationMs })

    // Always clean up — even if the status write failed
    yield* cleanupSession(taskId, deps.cleanupDeps).pipe(
      Effect.catchTag("SessionCleanupError", (e) => {
        log.error("Cleanup after completion failed", {
          taskId,
          error: e.message,
        })
        return Effect.void
      })
    )

    if (dbError) return yield* dbError
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

/**
 * Manually mark a failed or cancelled task as done.
 * Useful when a task actually completed its work but the agent process exited
 * with a non-zero code or was cancelled after finishing.
 */
export function resolveTask(
  deps: TaskManagerDeps,
  taskId: string,
): Effect.Effect<void, TaskNotFoundError | TaskNotTerminalError> {
  return Effect.gen(function* () {
    const task = yield* deps.getTask(taskId).pipe(
      Effect.mapError(() => new TaskNotFoundError({ taskId }))
    )

    if (!task) {
      return yield* new TaskNotFoundError({ taskId })
    }

    if (task.status !== "failed" && task.status !== "cancelled") {
      return yield* new TaskNotTerminalError({ taskId, status: task.status })
    }

    // Set completed_at if not already set — prevents the dashboard duration timer
    // from ticking indefinitely on tasks that were failed before being resolved.
    const completedAt = task.completed_at ?? new Date().toISOString()
    yield* deps.updateTask(taskId, { status: "done", completed_at: completedAt }).pipe(Effect.ignoreLogged)

    yield* deps.logActivity(taskId, "lifecycle", "task.resolved", "Task manually marked as done").pipe(
      Effect.catchAll(() => Effect.void)
    )

    emitStatusChange(taskId, "done")
    log.info("Task resolved", { taskId })
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
        && t.type !== "orchestrator"
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
  model?: string,
  reasoningEffort?: string,
): Effect.Effect<TaskRow, Error> {
  return Effect.gen(function* () {
    const orchestrators = (yield* deps.listTasks({ projectId }))
      .filter((t) => t.type === "orchestrator")

    const active = orchestrators.find((t) => !TERMINAL_STATUSES.has(t.status))
    if (active) return active

    // Link to most recent terminal orchestrator for history chain
    const parent = orchestrators
      .filter((t) => TERMINAL_STATUSES.has(t.status))
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0]

    // Default to claude-sonnet-4-6 medium for claude-code orchestrators
    const projectConfig = deps.getProjectConfig(projectId)
    const resolvedProvider = provider ?? projectConfig?.defaultProvider ?? DEFAULT_PROVIDER
    const isClaude = resolvedProvider === "claude-code"

    const defaultPrompt = `You are the orchestrator for the "${projectId}" project. You are running on the default branch (main repo, not a worktree).

Your role:
- **Coordinate work**: Create worker tasks for features, bugs, and refactors. Create reviewer tasks for code review — never use workers for review.
- **Monitor tasks**: Check task status via the API. Send prompts to nudge or unblock running agents.

## Model and provider selection

Choose based on task complexity. Pass \`"model"\` and optionally \`"provider"\` when creating tasks.
- **claude-opus-4-6** (claude-code) — complex features, multi-file refactors, architecture work, deep reasoning
- **claude-sonnet-4-6** (claude-code) — straightforward bug fixes, single-file changes, simple features, and **review tasks**

Default to opus for ambiguous complexity.

Start by loading the tangerine-tasks skill (\`/tangerine-tasks\`) and checking active tasks via the API.`

    return yield* createTask(deps, {
      source: "manual",
      projectId,
      title: ORCHESTRATOR_TASK_NAME,
      type: "orchestrator",
      description: projectConfig?.taskTypes?.orchestrator?.systemPrompt ?? projectConfig?.orchestratorPrompt ?? defaultPrompt,
      provider,
      model: model ?? (isClaude ? "claude-sonnet-4-6" : undefined),
      reasoningEffort: reasoningEffort ?? (isClaude ? "medium" : undefined),
      parentTaskId: parent?.id,
    })
  })
}

/**
 * Start a session for a task in "created" status (on-demand).
 * No-ops if the task is already running or terminal.
 */
export function startTask(
  deps: TaskManagerDeps,
  taskId: string,
): Effect.Effect<void, TaskNotFoundError | DbError> {
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
      return yield* Effect.fail(new DbError({ message: `Unknown project: ${task.project_id}` }))
    }

    // Atomically transition created → provisioning to prevent concurrent starts.
    // If another request already moved the status, this update is a no-op and
    // the re-read below will see a non-"created" status, so we bail out.
    yield* deps.updateTask(taskId, { status: "provisioning" }).pipe(
      Effect.mapError((cause) => new DbError({ message: `Failed to persist provisioning status for task ${taskId}`, cause }))
    )
    const current = yield* deps.getTask(taskId).pipe(
      Effect.mapError(() => new TaskNotFoundError({ taskId }))
    )
    if (!current || current.status !== "provisioning") return

    log.info("Starting task on demand", { taskId, title: task.title })
    emitStatusChange(taskId, "provisioning")
    const taskLifecycleDeps = depsForProvider(deps, task.provider)
    yield* Effect.forkDaemon(
      startSessionWithRetry(current, projectConfig, taskLifecycleDeps, deps.retryDeps)
    )
  })
}
