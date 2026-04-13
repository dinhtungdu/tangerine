import { Effect } from "effect"
import { Hono } from "hono"
import { SUPPORTED_PROVIDERS } from "@tangerine/shared"
import type { AppDeps } from "../app"
import { mapTaskRow } from "../helpers"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { getTask, listTasks, updateTask, deleteTask, markTaskSeen, getChildTasks } from "../../db/queries"
import { TaskNotFoundError, TaskNotTerminalError, PrCapabilityError, BranchRenameError } from "../../errors"
import { getAgentWorkingState, hasAgentWorkingState } from "../../tasks/events"
import { getRepoDir } from "../../config"
import { ghSpawnEnv } from "../../gh"
import { localExecStrict } from "./../../tasks/worktree-pool"
import { isValidReasoningEffort, getValidReasoningEfforts } from "../../agent/metadata"

const VALID_PROVIDERS = new Set<string>(SUPPORTED_PROVIDERS)
const PROVIDER_LIST = SUPPORTED_PROVIDERS.join(", ")

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
    const body = await c.req.json<{ projectId?: string; title?: string; type?: "worker" | "orchestrator" | "reviewer"; description?: string; provider?: string; model?: string; reasoningEffort?: string; source?: string; sourceId?: string; sourceUrl?: string; branch?: string; parentTaskId?: string; images?: import("../../agent/provider").PromptImage[] }>()
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
    const validTypes = new Set(["worker", "orchestrator", "reviewer"])
    if (body.type && !validTypes.has(body.type)) {
      return c.json({ error: `Invalid type: ${body.type}. Must be worker, orchestrator, or reviewer` }, 400)
    }
    const source = body.source === "cross-project" ? "cross-project" : "manual"

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
      deps.taskManager.createTask({ source, projectId, title: body.title, type: body.type, description: body.description, provider: body.provider, model: body.model, reasoningEffort: body.reasoningEffort, sourceId, sourceUrl, branch, parentTaskId: body.parentTaskId, images: body.images }).pipe(
        Effect.map(mapTaskRow)
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
                source: task.source as "manual" | "github" | "api" | "cross-project",
                projectId: task.project_id,
                title: task.title,
                type: (task.type ?? "worker") as "worker" | "orchestrator" | "reviewer",
                description: task.description ?? undefined,
                sourceId: task.source_id ?? undefined,
                sourceUrl: task.source_url ?? undefined,
                provider: task.provider,
                model: task.model ?? undefined,
                reasoningEffort: task.reasoning_effort ?? undefined,
                parentTaskId: task.parent_task_id ?? undefined,
              }).pipe(Effect.mapError((e) => new Error(String(e))))
            ),
            Effect.map(mapTaskRow),
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
        return mapTaskRow(updated)
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
          return mapTaskRow(task)
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
        return mapTaskRow(updated)
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
