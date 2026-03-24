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

  app.post("/:id/model", async (c) => {
    const body = await c.req.json<{ model?: string; reasoningEffort?: string }>()
    if (!body.model && !body.reasoningEffort) {
      return c.json({ error: "model or reasoningEffort is required" }, 400)
    }
    return runEffectVoid(c,
      deps.taskManager.changeConfig(c.req.param("id"), { model: body.model, reasoningEffort: body.reasoningEffort })
    )
  })

  app.get("/:id/activities", (c) => {
    return runEffect(c,
      getActivities(deps.db, c.req.param("id")).pipe(
        Effect.map((rows) => rows.map(normalizeTimestamps))
      )
    )
  })

  return app
}
