import { Effect } from "effect"
import { Hono } from "hono"
import { CronExpressionParser } from "cron-parser"
import type { AppDeps } from "../app"
import { mapCronRow } from "../helpers"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { createCron, getCron, listCrons, updateCron, deleteCron } from "../../db/queries"

export function cronRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const projectId = c.req.query("project") || undefined
    return runEffect(c,
      listCrons(deps.db, { projectId }).pipe(
        Effect.map(rows => rows.map(mapCronRow))
      )
    )
  })

  app.get("/:id", (c) => {
    return runEffect(c,
      getCron(deps.db, c.req.param("id")).pipe(
        Effect.flatMap((row) =>
          row ? Effect.succeed(mapCronRow(row)) : Effect.fail(new Error(`Cron ${c.req.param("id")} not found`))
        )
      )
    )
  })

  app.post("/", async (c) => {
    const body = await c.req.json<{
      projectId?: string
      title?: string
      description?: string
      cron?: string
      enabled?: boolean
      taskDefaults?: { provider?: string; model?: string; reasoningEffort?: string; branch?: string }
    }>()

    if (!body.title) return c.json({ error: "title is required" }, 400)
    if (!body.cron) return c.json({ error: "cron is required" }, 400)

    try {
      CronExpressionParser.parse(body.cron)
    } catch {
      return c.json({ error: `Invalid cron expression: ${body.cron}` }, 400)
    }

    const projectId = body.projectId || deps.config.config.projects[0]!.name
    const project = deps.config.config.projects.find((p) => p.name === projectId)
    if (!project) return c.json({ error: `Unknown project: ${projectId}` }, 400)

    const interval = CronExpressionParser.parse(body.cron)
    const nextRunAt = interval.next().toISOString() as string

    return runEffect(c,
      createCron(deps.db, {
        id: crypto.randomUUID(),
        project_id: projectId,
        title: body.title,
        description: body.description ?? null,
        cron: body.cron,
        enabled: body.enabled === false ? 0 : 1,
        next_run_at: nextRunAt,
        task_defaults: body.taskDefaults ? JSON.stringify(body.taskDefaults) : null,
      }).pipe(Effect.map(mapCronRow)),
      { status: 201 }
    )
  })

  app.patch("/:id", async (c) => {
    const id = c.req.param("id")
    const body = await c.req.json<{
      title?: string
      description?: string
      cron?: string
      enabled?: boolean
      taskDefaults?: { provider?: string; model?: string; reasoningEffort?: string; branch?: string } | null
    }>()

    return runEffect(c,
      Effect.gen(function* () {
        const existing = yield* getCron(deps.db, id)
        if (!existing) return yield* Effect.fail(new Error(`Cron ${id} not found`))

        const fields: Record<string, string | number | null> = {}
        if ("title" in body) fields.title = body.title ?? existing.title
        if ("description" in body) fields.description = body.description ?? null
        if ("enabled" in body) fields.enabled = body.enabled ? 1 : 0
        if ("taskDefaults" in body) fields.task_defaults = body.taskDefaults ? JSON.stringify(body.taskDefaults) : null

        if ("cron" in body && body.cron) {
          try {
            CronExpressionParser.parse(body.cron)
          } catch {
            return yield* Effect.fail(new Error(`Invalid cron expression: ${body.cron}`))
          }
          fields.cron = body.cron
          const interval = CronExpressionParser.parse(body.cron)
          fields.next_run_at = interval.next().toISOString() as string
        }

        const updated = yield* updateCron(deps.db, id, fields)
        if (!updated) return yield* Effect.fail(new Error(`Cron ${id} not found`))
        return mapCronRow(updated)
      })
    )
  })

  app.delete("/:id", (c) => {
    return runEffectVoid(c,
      deleteCron(deps.db, c.req.param("id"))
    )
  })

  return app
}
