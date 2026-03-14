import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { mapTaskRow } from "../helpers"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { getTask, listTasks } from "../../db/queries"

export function taskRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const status = c.req.query("status")
    return runEffect(c,
      listTasks(deps.db, status).pipe(
        Effect.map(rows => rows.map(mapTaskRow))
      )
    )
  })

  app.get("/:id", (c) => {
    return runEffect(c,
      getTask(deps.db, c.req.param("id")).pipe(
        Effect.flatMap((task) =>
          task ? Effect.succeed(mapTaskRow(task)) : Effect.fail(new Error("Task not found"))
        )
      )
    )
  })

  app.post("/", async (c) => {
    const body = await c.req.json<{ title?: string; description?: string }>()
    if (!body.title) {
      return c.json({ error: "title is required" }, 400)
    }
    return runEffect(c,
      deps.taskManager.createTask("manual", body.title, body.description).pipe(
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

  app.post("/:id/done", (c) => {
    return runEffectVoid(c,
      deps.taskManager.completeTask(c.req.param("id"))
    )
  })

  return app
}
