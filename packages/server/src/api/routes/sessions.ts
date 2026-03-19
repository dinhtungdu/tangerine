import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { getTask, getSessionLogs } from "../../db/queries"
import { getActivities } from "../../activity"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { normalizeTimestamps } from "../helpers"
import { TaskNotFoundError } from "../../errors"

export function sessionRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.get("/:id/messages", (c) => {
    return runEffect(c,
      getSessionLogs(deps.db, c.req.param("id")).pipe(
        Effect.map((rows) => rows.map(normalizeTimestamps))
      )
    )
  })

  app.post("/:id/prompt", async (c) => {
    const body = await c.req.json<{ text?: string }>()
    if (!body.text) {
      return c.json({ error: "text is required" }, 400)
    }
    return runEffectVoid(c,
      deps.taskManager.sendPrompt(c.req.param("id"), body.text)
    )
  })

  // REST chat endpoint: sends a prompt and persists the user message.
  // Async — returns immediately. Use GET /messages or WebSocket for agent response.
  app.post("/:id/chat", async (c) => {
    const taskId = c.req.param("id")
    const body = await c.req.json<{ text?: string }>()
    if (!body.text) {
      return c.json({ error: "text is required" }, 400)
    }
    return runEffect(c,
      Effect.gen(function* () {
        const task = yield* getTask(deps.db, taskId)
        if (!task) return yield* Effect.fail(new TaskNotFoundError({ taskId }))

        // Send to agent (sendPrompt persists the user message to session_logs)
        yield* deps.taskManager.sendPrompt(taskId, body.text!)

        return { ok: true, taskId, status: task.status }
      }),
      { status: 202 }
    )
  })

  app.post("/:id/abort", (c) => {
    return runEffectVoid(c,
      deps.taskManager.abortTask(c.req.param("id"))
    )
  })

  // Dev server control
  app.post("/:id/server/start", (c) => {
    return runEffectVoid(c, deps.devServer.start(c.req.param("id")))
  })

  app.post("/:id/server/stop", (c) => {
    return runEffectVoid(c, deps.devServer.stop(c.req.param("id")))
  })

  app.get("/:id/server/status", (c) => {
    return runEffect(c, deps.devServer.status(c.req.param("id")))
  })

  app.get("/:id/activities", (c) => {
    return runEffect(c,
      getActivities(deps.db, c.req.param("id")).pipe(
        Effect.map((rows) => rows.map(normalizeTimestamps))
      )
    )
  })

  app.get("/:id/diff", (c) => {
    const id = c.req.param("id")
    // Placeholder: real implementation requires OpenCode client
    return runEffect(c,
      getTask(deps.db, id).pipe(
        Effect.map(() => ({ taskId: id, diff: "" }))
      )
    )
  })

  return app
}
