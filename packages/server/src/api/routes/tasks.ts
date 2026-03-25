import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { mapTaskRow } from "../helpers"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { getTask, listTasks, updateTask, deleteTask } from "../../db/queries"
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
    const body = await c.req.json<{ projectId?: string; title?: string; description?: string; provider?: string; model?: string; reasoningEffort?: string; source?: string; sourceId?: string; sourceUrl?: string; images?: import("../../agent/provider").PromptImage[] }>()
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
    return runEffect(c,
      deps.taskManager.createTask({ source, projectId, title: body.title, description: body.description, provider, model: body.model, reasoningEffort: body.reasoningEffort, sourceId: body.sourceId, sourceUrl: body.sourceUrl, images: body.images }).pipe(
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
              }).pipe(Effect.mapError((e) => new Error(String(e))))
            ),
            Effect.map(mapTaskRow),
          )
        }),
      ),
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
