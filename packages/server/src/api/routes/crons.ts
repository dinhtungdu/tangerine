import { Effect } from "effect"
import { Hono } from "hono"
import { CronExpressionParser } from "cron-parser"
import type { AppDeps } from "../app"
import { mapCronRow } from "../helpers"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { createCron, getCron, listCrons, updateCron, deleteCron } from "../../db/queries"
import { CronNotFoundError, CronValidationError } from "../../errors"

/** Validate a cron expression is exactly 5 fields (no seconds field). */
function validateCron(expr: string): Effect.Effect<void, CronValidationError> {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    return Effect.fail(new CronValidationError({ message: `Invalid cron expression: expected 5 fields, got ${fields.length}` }))
  }
  try {
    CronExpressionParser.parse(expr)
    return Effect.void
  } catch {
    return Effect.fail(new CronValidationError({ message: `Invalid cron expression: ${expr}` }))
  }
}

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
          row ? Effect.succeed(mapCronRow(row)) : Effect.fail(new CronNotFoundError({ cronId: c.req.param("id") }))
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

    const projectId = body.projectId || deps.config.config.projects[0]!.name
    const project = deps.config.config.projects.find((p) => p.name === projectId)
    if (!project) return c.json({ error: `Unknown project: ${projectId}` }, 400)

    return runEffect(c,
      Effect.gen(function* () {
        yield* validateCron(body.cron!)
        const interval = CronExpressionParser.parse(body.cron!)
        const nextRunAt = interval.next().toISOString() as string

        const row = yield* createCron(deps.db, {
          id: crypto.randomUUID(),
          project_id: projectId,
          title: body.title!,
          description: body.description ?? null,
          cron: body.cron!,
          enabled: body.enabled === false ? 0 : 1,
          next_run_at: nextRunAt,
          task_defaults: body.taskDefaults ? JSON.stringify(body.taskDefaults) : null,
        })
        return mapCronRow(row)
      }),
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
        if (!existing) return yield* Effect.fail(new CronNotFoundError({ cronId: id }))

        const fields: Record<string, string | number | null> = {}
        if ("title" in body) fields.title = body.title ?? existing.title
        if ("description" in body) fields.description = body.description ?? null
        if ("enabled" in body) fields.enabled = body.enabled ? 1 : 0
        if ("taskDefaults" in body) fields.task_defaults = body.taskDefaults ? JSON.stringify(body.taskDefaults) : null

        if ("cron" in body && body.cron) {
          yield* validateCron(body.cron)
          fields.cron = body.cron
          const interval = CronExpressionParser.parse(body.cron)
          fields.next_run_at = interval.next().toISOString() as string
        }

        const updated = yield* updateCron(deps.db, id, fields)
        if (!updated) return yield* Effect.fail(new CronNotFoundError({ cronId: id }))
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
