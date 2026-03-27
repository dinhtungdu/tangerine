import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { mapTaskRow } from "../helpers"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { getTask, listTasks, updateTask, deleteTask, markTaskSeen } from "../../db/queries"
import { TaskNotFoundError, TaskNotTerminalError } from "../../errors"

export function taskRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const status = c.req.query("status") || undefined
    const projectId = c.req.query("project") || undefined
    const search = c.req.query("search") || undefined
    return runEffect(c,
      listTasks(deps.db, { status, projectId, search }).pipe(
        Effect.map(rows => rows.map(mapTaskRow))
      )
    )
  })

  app.get("/:id", (c) => {
    return runEffect(c,
      getTask(deps.db, c.req.param("id")).pipe(
        Effect.flatMap((task) =>
          task ? Effect.succeed(mapTaskRow(task)) : Effect.fail(new TaskNotFoundError({ taskId: c.req.param("id") }))
        )
      )
    )
  })

  app.post("/", async (c) => {
    const body = await c.req.json<{ projectId?: string; title?: string; description?: string; provider?: string; model?: string; reasoningEffort?: string; source?: string; sourceId?: string; sourceUrl?: string; branch?: string; images?: import("../../agent/provider").PromptImage[]; type?: "code" | "review"; reviewPrNumber?: number; reviewTaskId?: string }>()
    if (!body.title) {
      return c.json({ error: "title is required" }, 400)
    }
    // Default to first project if not specified
    const projectId = body.projectId || deps.config.config.projects[0]!.name
    const project = deps.config.config.projects.find((p) => p.name === projectId)
    if (!project) {
      return c.json({ error: `Unknown project: ${projectId}` }, 400)
    }
    const provider = body.provider === "claude-code" ? "claude-code" : "opencode"
    const source = body.source === "cross-project" ? "cross-project" : "manual"
    const taskType = body.type === "review" ? "review" : "code"

    // Resolve branch from PR URL or direct branch name
    let branch = body.branch
    let sourceUrl = body.sourceUrl
    let sourceId = body.sourceId
    const reviewPrNumber = body.reviewPrNumber
    const reviewTaskId = body.reviewTaskId

    // For review tasks targeting a Tangerine task, resolve branch from that task's PR/branch
    if (taskType === "review" && reviewTaskId) {
      const targetTask = await Effect.runPromise(
        getTask(deps.db, reviewTaskId).pipe(Effect.catchAll(() => Effect.succeed(null)))
      )
      if (!targetTask) {
        return c.json({ error: `Review target task not found: ${reviewTaskId}` }, 400)
      }
      branch = branch ?? targetTask.branch ?? undefined
      if (targetTask.pr_url) {
        sourceUrl = sourceUrl ?? targetTask.pr_url
      }
    } else if (taskType === "review" && reviewPrNumber) {
      // For review tasks targeting an external PR
      const prInfo = await resolvePrBranch(`#${reviewPrNumber}`, `/workspace/${projectId}/repo`)
      if (prInfo) {
        branch = branch ?? prInfo.branch
        sourceUrl = sourceUrl ?? prInfo.url
        sourceId = sourceId ?? prInfo.sourceId
      }
    } else if (branch) {
      const prInfo = await resolvePrBranch(branch, `/workspace/${projectId}/repo`)
      if (prInfo) {
        branch = prInfo.branch
        sourceUrl = sourceUrl ?? prInfo.url
        sourceId = sourceId ?? prInfo.sourceId
      }
    }

    if (taskType === "review" && !reviewPrNumber && !reviewTaskId) {
      return c.json({ error: "reviewPrNumber or reviewTaskId is required for review tasks" }, 400)
    }

    return runEffect(c,
      deps.taskManager.createTask({ source, projectId, title: body.title, description: body.description, provider, model: body.model, reasoningEffort: body.reasoningEffort, sourceId, sourceUrl, branch, images: body.images, type: taskType, reviewPrNumber, reviewTaskId }).pipe(
        Effect.map(mapTaskRow)
      ),
      { status: 201 }
    )
  })

  app.post("/:id/cancel", (c) => {
    return runEffectVoid(c,
      deps.taskManager.cancelTask(c.req.param("id"))
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
                description: task.description ?? undefined,
                sourceId: task.source_id ?? undefined,
                sourceUrl: task.source_url ?? undefined,
                provider: task.provider,
                model: task.model ?? undefined,
                reasoningEffort: task.reasoning_effort ?? undefined,
                type: (task.type as "code" | "review") ?? "code",
                reviewPrNumber: task.review_pr_number ?? undefined,
                reviewTaskId: task.review_task_id ?? undefined,
              }).pipe(Effect.mapError((e) => new Error(String(e))))
            ),
            Effect.map(mapTaskRow),
          )
        }),
      ),
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
const PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
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
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
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
