import { Effect } from "effect"
import { Hono } from "hono"
import { SUPPORTED_PROVIDERS, getCapabilitiesForType } from "@tangerine/shared"
import type { TaskWriteResponse, TaskType, TaskSource, TaskTree, TreeTurn, TaskMeta, TaskStatus, ProviderType } from "@tangerine/shared"
import type { AppDeps } from "../app"
import { mapTaskRow, mapCheckpointRow } from "../helpers"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { getTask, listTasks, updateTask, deleteTask, markTaskSeen, getChildTasks, countTasksByProject, listCheckpoints, getCheckpoint, getAllFamilyTaskIds, getTasksByIds, getCheckpointsWithPreviewForTasks } from "../../db/queries"
import { TaskNotFoundError, TaskNotTerminalError, PrCapabilityError, BranchRenameError, CheckpointNotFoundError, BranchError } from "../../errors"
import { getAgentWorkingState, hasAgentWorkingState } from "../../tasks/events"
import { getRepoDir } from "../../config"
import { ghSpawnEnv } from "../../gh"
import { localExecStrict } from "./../../tasks/worktree-pool"
import { isValidReasoningEffort, getValidReasoningEfforts } from "../../agent/metadata"

const VALID_PROVIDERS = new Set<string>(SUPPORTED_PROVIDERS)
const PROVIDER_LIST = SUPPORTED_PROVIDERS.join(", ")

const toWriteResponse = (row: { id: string; title: string; status: string }): TaskWriteResponse =>
  ({ id: row.id, title: row.title, status: row.status as TaskWriteResponse["status"] })

export function taskRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const status = c.req.query("status") || undefined
    const projectId = c.req.query("project") || undefined
    const search = c.req.query("search") || undefined
    const limitStr = c.req.query("limit")
    const offsetStr = c.req.query("offset")
    const limitParsed = limitStr ? parseInt(limitStr, 10) : NaN
    const offsetParsed = offsetStr ? parseInt(offsetStr, 10) : NaN
    const limit = !isNaN(limitParsed) ? Math.max(1, limitParsed) : undefined
    const offset = !isNaN(offsetParsed) ? Math.max(0, offsetParsed) : undefined
    return runEffect(c,
      listTasks(deps.db, { status, projectId, search, limit, offset }).pipe(
        Effect.map(rows => rows.map(row => {
          const task = mapTaskRow(row)
          if (task.status === "running") {
            // Suspended tasks are always idle — their agentWorkingState is lost on restart
            // but suspended=true in the DB is the authoritative source of truth.
            if (task.suspended) task.agentStatus = "idle"
            else if (hasAgentWorkingState(task.id)) task.agentStatus = getAgentWorkingState(task.id)
          }
          return task
        }))
      )
    )
  })

  app.get("/counts", (c) => {
    const status = c.req.query("status") || undefined
    const search = c.req.query("search") || undefined
    return runEffect(c, countTasksByProject(deps.db, { status, search }))
  })

  app.get("/:id", (c) => {
    return runEffect(c,
      getTask(deps.db, c.req.param("id")).pipe(
        Effect.flatMap((row) => {
          if (!row) return Effect.fail(new TaskNotFoundError({ taskId: c.req.param("id") }))
          const task = mapTaskRow(row)
          if (task.status === "running") {
            if (task.suspended) task.agentStatus = "idle"
            else if (hasAgentWorkingState(task.id)) task.agentStatus = getAgentWorkingState(task.id)
          }
          return Effect.succeed(task)
        })
      )
    )
  })

  app.post("/", async (c) => {
    const body = await c.req.json<{ projectId?: string; title?: string; type?: "worker" | "orchestrator" | "reviewer" | "runner"; description?: string; provider?: string; model?: string; reasoningEffort?: string; source?: string; sourceId?: string; sourceUrl?: string; branch?: string; prUrl?: string; parentTaskId?: string; images?: import("../../agent/provider").PromptImage[] }>()
    if (!body.title) {
      return c.json({ error: "title is required" }, 400)
    }
    // Default to first project if not specified
    const projectId = body.projectId || deps.config.config.projects[0]!.name
    const project = deps.config.config.projects.find((p) => p.name === projectId)
    if (!project) {
      return c.json({ error: `Unknown project: ${projectId}` }, 400)
    }
    if (project.archived) {
      return c.json({ error: `Project "${projectId}" is archived — unarchive it before creating tasks` }, 400)
    }
    if (body.provider !== undefined && !VALID_PROVIDERS.has(body.provider)) {
      return c.json({ error: `Invalid provider: ${body.provider}. Must be ${PROVIDER_LIST}` }, 400)
    }
    if (body.reasoningEffort !== undefined) {
      // Validate against the effective provider (explicit > project default)
      const effectiveProvider = body.provider ?? project.defaultProvider
      if (effectiveProvider !== undefined && !isValidReasoningEffort(effectiveProvider, body.reasoningEffort)) {
        const valid = getValidReasoningEfforts(effectiveProvider).join(", ")
        return c.json({ error: `Invalid reasoningEffort "${body.reasoningEffort}" for provider "${effectiveProvider}". Must be one of: ${valid}` }, 400)
      }
    }
    const validTypes = new Set(["worker", "orchestrator", "reviewer", "runner"])
    if (body.type && !validTypes.has(body.type)) {
      return c.json({ error: `Invalid type: ${body.type}. Must be worker, orchestrator, reviewer, or runner` }, 400)
    }
    const source = body.source === "cross-project" ? "cross-project" : "manual"

    if (body.prUrl && !getCapabilitiesForType((body.type ?? "worker") as TaskType).includes("pr-track")) {
      return c.json({ error: `prUrl is not allowed for task type "${body.type ?? "worker"}" — only pr-track capable types (worker, reviewer) support PR tracking` }, 400)
    }

    // Resolve branch from PR URL or direct branch name
    let branch = body.branch
    let sourceUrl = body.sourceUrl
    let sourceId = body.sourceId
    if (branch) {
      const prInfo = await resolvePrBranch(branch, getRepoDir(deps.config.config, projectId))
      if (prInfo) {
        branch = prInfo.branch
        sourceUrl = sourceUrl ?? prInfo.url
        sourceId = sourceId ?? prInfo.sourceId
      } else if (PR_NUM_RE.test(branch)) {
        // PR ref like "#123" that failed to resolve — refuse rather than pass a
        // literal "#123" as a branch name (would crash git checkout)
        return c.json({ error: `Could not resolve PR reference: ${branch}` }, 400)
      }
    }

    return runEffect(c,
      deps.taskManager.createTask({ source, projectId, title: body.title, type: body.type, description: body.description, provider: body.provider, model: body.model, reasoningEffort: body.reasoningEffort, sourceId, sourceUrl, branch, prUrl: body.prUrl, parentTaskId: body.parentTaskId, images: body.images }).pipe(
        Effect.map(toWriteResponse)
      ),
      { status: 201 }
    )
  })

  app.get("/:id/children", (c) => {
    return runEffect(c,
      getChildTasks(deps.db, c.req.param("id")).pipe(
        Effect.map(rows => rows.map(mapTaskRow))
      )
    )
  })

  app.get("/:id/checkpoints", (c) => {
    const taskId = c.req.param("id")
    return runEffect(c,
      Effect.gen(function* () {
        const row = yield* getTask(deps.db, taskId)
        if (!row) return yield* Effect.fail(new TaskNotFoundError({ taskId }))
        const checkpoints = yield* listCheckpoints(deps.db, taskId)
        return checkpoints.map(mapCheckpointRow)
      })
    )
  })

  app.get("/:id/tree", (c) => {
    const taskId = c.req.param("id")
    return runEffect(c,
      Effect.gen(function* () {
        const task = yield* getTask(deps.db, taskId)
        if (!task) return yield* Effect.fail(new TaskNotFoundError({ taskId }))

        const familyIds = yield* getAllFamilyTaskIds(deps.db, taskId)
        const [taskRows, checkpointsWithPreview] = yield* Effect.all([
          getTasksByIds(deps.db, familyIds),
          getCheckpointsWithPreviewForTasks(deps.db, familyIds),
        ])

        const allTasks = new Map(taskRows.map((t) => [t.id, t]))
        const checkpointsByTask = new Map<string, typeof checkpointsWithPreview>()
        for (const cp of checkpointsWithPreview) {
          if (!checkpointsByTask.has(cp.task_id)) checkpointsByTask.set(cp.task_id, [])
          checkpointsByTask.get(cp.task_id)!.push(cp)
        }
        const branchesByCheckpoint = new Map<string, string[]>()
        for (const row of taskRows) {
          if (row.branched_from_checkpoint_id) {
            const existing = branchesByCheckpoint.get(row.branched_from_checkpoint_id) ?? []
            existing.push(row.id)
            branchesByCheckpoint.set(row.branched_from_checkpoint_id, existing)
          }
        }

        const root = taskRows.find((t) => !t.parent_task_id || !allTasks.has(t.parent_task_id))
        if (!root) return yield* Effect.fail(new TaskNotFoundError({ taskId }))

        // Build flat structure with levels
        const turns: TreeTurn[] = []
        const tasks: Record<string, TaskMeta> = {}
        const taskStartLevel = new Map<string, number>([[root.id, 1]])
        const queue = [root.id]

        while (queue.length > 0) {
          const currentTaskId = queue.shift()!
          const t = allTasks.get(currentTaskId)!
          tasks[t.id] = {
            taskId: t.id,
            parentTaskId: t.parent_task_id,
            title: t.title,
            status: t.status as TaskStatus,
            provider: t.provider as ProviderType,
            model: t.model,
          }

          let level = taskStartLevel.get(currentTaskId) ?? 1
          const cps = checkpointsByTask.get(currentTaskId) ?? []

          // Tasks with no checkpoints yet still need a row in the tree
          if (cps.length === 0) {
            turns.push({
              level,
              checkpointId: `pending:${currentTaskId}`,
              taskId: currentTaskId,
              turnIndex: -1,
              message: "",
              createdAt: t.created_at,
              parentCheckpointId: t.branched_from_checkpoint_id,
            })
          }

          for (const cp of cps) {
            turns.push({
              level,
              checkpointId: cp.id,
              taskId: currentTaskId,
              turnIndex: cp.turn_index,
              message: cp.preview,
              createdAt: cp.created_at,
              parentCheckpointId: t.branched_from_checkpoint_id,
            })

            const branches = branchesByCheckpoint.get(cp.id) ?? []
            if (branches.length > 0) {
              level++
              for (const branchId of branches) {
                taskStartLevel.set(branchId, level)
                queue.push(branchId)
              }
            }
          }
        }

        turns.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

        return { turns, tasks } as TaskTree
      })
    )
  })

  // Branch from a checkpoint — create a new task starting from a specific point in history
  app.post("/:id/branch", async (c) => {
    const sourceTaskId = c.req.param("id")
    const body = await c.req.json<{
      checkpoint_id: string
      title: string
      description?: string
      provider?: string
      model?: string
      reasoningEffort?: string
    }>()

    if (!body.checkpoint_id) {
      return c.json({ error: "checkpoint_id is required" }, 400)
    }
    if (!body.title) {
      return c.json({ error: "title is required" }, 400)
    }
    if (body.provider !== undefined && !VALID_PROVIDERS.has(body.provider)) {
      return c.json({ error: `Invalid provider: ${body.provider}. Must be ${PROVIDER_LIST}` }, 400)
    }

    return runEffect(c,
      Effect.gen(function* () {
        // Validate source task exists
        const sourceTask = yield* getTask(deps.db, sourceTaskId)
        if (!sourceTask) return yield* Effect.fail(new TaskNotFoundError({ taskId: sourceTaskId }))

        // Validate checkpoint exists and belongs to source task
        const checkpoint = yield* getCheckpoint(deps.db, body.checkpoint_id)
        if (!checkpoint) return yield* Effect.fail(new CheckpointNotFoundError({ checkpointId: body.checkpoint_id }))
        if (checkpoint.task_id !== sourceTaskId) {
          return yield* Effect.fail(new BranchError({
            message: `Checkpoint ${body.checkpoint_id} does not belong to task ${sourceTaskId}`,
            taskId: sourceTaskId,
            checkpointId: body.checkpoint_id,
          }))
        }

        // Get project config
        const projectId = sourceTask.project_id
        const project = deps.config.config.projects.find((p) => p.name === projectId)
        if (!project) {
          return yield* Effect.fail(new BranchError({
            message: `Unknown project: ${projectId}`,
            taskId: sourceTaskId,
          }))
        }
        if (project.archived) {
          return yield* Effect.fail(new BranchError({
            message: `Project "${projectId}" is archived — unarchive it before creating tasks`,
            taskId: sourceTaskId,
          }))
        }

        // Validate reasoning effort if provided
        if (body.reasoningEffort !== undefined) {
          const effectiveProvider = body.provider ?? sourceTask.provider
          if (!isValidReasoningEffort(effectiveProvider, body.reasoningEffort)) {
            const valid = getValidReasoningEfforts(effectiveProvider).join(", ")
            return yield* Effect.fail(new BranchError({
              message: `Invalid reasoningEffort "${body.reasoningEffort}" for provider "${effectiveProvider}". Must be one of: ${valid}`,
              taskId: sourceTaskId,
            }))
          }
        }

        // Create new task with branched_from_checkpoint_id
        const newTask = yield* deps.taskManager.createTask({
          source: "branch",
          projectId,
          title: body.title,
          type: "worker",
          description: body.description,
          provider: body.provider ?? sourceTask.provider,
          model: body.model ?? sourceTask.model ?? undefined,
          reasoningEffort: body.reasoningEffort ?? sourceTask.reasoning_effort ?? undefined,
          parentTaskId: sourceTaskId,
          branchedFromCheckpointId: body.checkpoint_id,
        }).pipe(
          Effect.mapError((e) => new BranchError({ message: String(e), taskId: sourceTaskId, checkpointId: body.checkpoint_id }))
        )

        return toWriteResponse(newTask)
      }),
      { status: 201 }
    )
  })

  app.post("/:id/cancel", (c) => {
    return runEffectVoid(c,
      deps.taskManager.cancelTask(c.req.param("id"))
    )
  })

  app.post("/:id/resolve", (c) => {
    return runEffectVoid(c,
      deps.taskManager.resolveTask(c.req.param("id"))
    )
  })

  app.post("/:id/retry", (c) => {
    const taskId = c.req.param("id")
    return runEffect(c,
      getTask(deps.db, taskId).pipe(
        Effect.flatMap((task) => {
          if (!task) return Effect.fail(new TaskNotFoundError({ taskId }))
          if (task.status !== "failed" && task.status !== "cancelled") return Effect.fail(new Error("Only failed or cancelled tasks can be retried"))

          // Clean up old task's worktree, mark as cancelled, create fresh one
          return deps.taskManager.cleanupTask(taskId).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.flatMap(() => updateTask(deps.db, taskId, { status: "cancelled" })),
            Effect.flatMap(() =>
              deps.taskManager.createTask({
                source: task.source as TaskSource,
                projectId: task.project_id,
                title: task.title,
                type: (task.type ?? "worker") as "worker" | "orchestrator" | "reviewer" | "runner",
                description: task.description ?? undefined,
                sourceId: task.source_id ?? undefined,
                sourceUrl: task.source_url ?? undefined,
                provider: task.provider,
                model: task.model ?? undefined,
                reasoningEffort: task.reasoning_effort ?? undefined,
                parentTaskId: task.parent_task_id ?? undefined,
              }).pipe(Effect.mapError((e) => new Error(String(e))))
            ),
            Effect.map(toWriteResponse),
          )
        }),
      ),
    )
  })

  // On-demand session start for dormant tasks (e.g. orchestrator)
  app.post("/:id/start", (c) => {
    return runEffectVoid(c,
      deps.taskManager.startTask(c.req.param("id"))
    )
  })

  app.post("/:id/seen", (c) => {
    return runEffectVoid(c,
      markTaskSeen(deps.db, c.req.param("id"))
    )
  })

  app.post("/:id/done", (c) => {
    return runEffectVoid(c,
      deps.taskManager.completeTask(c.req.param("id"))
    )
  })

  // Partial update for agent-writable fields (e.g. pr_url after gh pr create)
  app.patch("/:id", async (c) => {
    const taskId = c.req.param("id")
    const body = await c.req.json<{ prUrl?: string }>()
    return runEffect(c,
      Effect.gen(function* () {
        const row = yield* getTask(deps.db, taskId)
        if (!row) return yield* Effect.fail(new TaskNotFoundError({ taskId }))
        if ("prUrl" in body && !mapTaskRow(row).capabilities.includes("pr-track")) {
          return yield* Effect.fail(new PrCapabilityError({ taskId }))
        }
        const fields: Record<string, string | number | null> = {}
        if ("prUrl" in body) fields.pr_url = body.prUrl ?? null
        const updated = yield* updateTask(deps.db, taskId, fields)
        if (!updated) return yield* Effect.fail(new TaskNotFoundError({ taskId }))
        return toWriteResponse(updated)
      })
    )
  })

  // Rename a task's branch (e.g. before creating a PR with a descriptive name).
  // Renames locally, pushes new branch with tracking, deletes old remote branch.
  app.post("/:id/rename-branch", async (c) => {
    const taskId = c.req.param("id")
    const body = await c.req.json<{ branch: string }>()
    if (!body.branch || typeof body.branch !== "string") {
      return c.json({ error: "branch is required" }, 400)
    }
    const newBranch = body.branch.trim()
    // Strict git ref-name validation: only allow alphanumeric, dash, underscore, dot, slash.
    // Rejects shell metacharacters (;$`|&(){}[]) to prevent injection via bash -c.
    if (!newBranch || !/^[a-zA-Z0-9._\-/]+$/.test(newBranch)) {
      return c.json({ error: "Invalid branch name — only alphanumeric, dash, underscore, dot, and slash allowed" }, 400)
    }

    return runEffect(c,
      Effect.gen(function* () {
        const task = yield* getTask(deps.db, taskId)
        if (!task) return yield* Effect.fail(new TaskNotFoundError({ taskId }))

        // Only tasks that create PRs should rename branches — reviewer tasks
        // track an existing PR by branch name, and renaming would break that.
        if (!mapTaskRow(task).capabilities.includes("pr-create")) {
          return yield* Effect.fail(new BranchRenameError({
            message: "Only tasks with pr-create capability can rename branches",
            taskId,
          }))
        }

        if (!task.worktree_path) {
          return yield* Effect.fail(new BranchRenameError({
            message: "Task has no worktree — cannot rename branch",
            taskId,
          }))
        }
        const oldBranch = task.branch
        if (!oldBranch) {
          return yield* Effect.fail(new BranchRenameError({
            message: "Task has no branch assigned",
            taskId,
          }))
        }
        // Reject renames for tasks pinned to an existing (non-tangerine) branch —
        // these were created from a PR or explicit branch and shouldn't be renamed.
        if (!oldBranch.startsWith("tangerine/")) {
          return yield* Effect.fail(new BranchRenameError({
            message: "Cannot rename a branch not managed by Tangerine",
            taskId,
          }))
        }
        if (oldBranch === newBranch) {
          return toWriteResponse(task)
        }

        const cwd = task.worktree_path

        // Rename local branch (agent pushes separately via git push -u origin HEAD)
        yield* localExecStrict(`cd "${cwd}" && git branch -m ${oldBranch} ${newBranch}`).pipe(
          Effect.mapError((e) => new BranchRenameError({
            message: `Failed to rename local branch: ${e.message}`,
            taskId,
            cause: e,
          }))
        )

        // Update DB
        const updated = yield* updateTask(deps.db, taskId, { branch: newBranch })
        if (!updated) return yield* Effect.fail(new TaskNotFoundError({ taskId }))
        return toWriteResponse(updated)
      })
    )
  })

  // Delete a terminal task (done/failed/cancelled) with cascading cleanup
  app.delete("/:id", (c) => {
    const taskId = c.req.param("id")
    return runEffectVoid(c,
      Effect.gen(function* () {
        const task = yield* getTask(deps.db, taskId)
        if (!task) return yield* Effect.fail(new TaskNotFoundError({ taskId }))
        const terminal = new Set(["done", "failed", "cancelled"])
        if (!terminal.has(task.status)) {
          return yield* Effect.fail(new TaskNotTerminalError({ taskId, status: task.status }))
        }
        yield* deps.taskManager.cleanupTask(taskId).pipe(Effect.catchAll(() => Effect.void))
        yield* deleteTask(deps.db, taskId)
      })
    )
  })

  return app
}

/** Patterns that look like a PR reference rather than a plain branch name */
const PR_URL_RE = /github(?:\.[a-z0-9-]+)*\.[a-z]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/
const PR_NUM_RE = /^#?(\d+)$/

interface PrInfo {
  branch: string
  url: string
  sourceId: string
}

/**
 * If the input looks like a GitHub PR URL or `#123`, resolve it to a branch name
 * using `gh pr view`. Returns null if the input is a plain branch name.
 */
async function resolvePrBranch(input: string, repoDir: string): Promise<PrInfo | null> {
  const urlMatch = input.match(PR_URL_RE)
  const numMatch = input.match(PR_NUM_RE)
  if (!urlMatch && !numMatch) return null

  const prRef = urlMatch ? input : numMatch![1]!
  try {
    const proc = Bun.spawn(
      ["gh", "pr", "view", prRef, "--json", "headRefName,url,number"],
      ghSpawnEnv({ cwd: repoDir }),
    )
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) return null
    const data = JSON.parse(stdout) as { headRefName: string; url: string; number: number }
    return {
      branch: data.headRefName,
      url: data.url,
      sourceId: `github:pr#${data.number}`,
    }
  } catch {
    return null
  }
}
