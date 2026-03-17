import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { getTask, getSessionLogs } from "../../db/queries"
import { getActivities } from "../../activity"
import { runEffect, runEffectVoid } from "../effect-helpers"

export function sessionRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.get("/:id/messages", (c) => {
    return runEffect(c,
      getSessionLogs(deps.db, c.req.param("id"))
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

  app.post("/:id/abort", (c) => {
    return runEffectVoid(c,
      deps.taskManager.abortTask(c.req.param("id"))
    )
  })

  app.get("/:id/activities", (c) => {
    return runEffect(c, getActivities(deps.db, c.req.param("id")))
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
