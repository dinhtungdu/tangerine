import { Hono } from "hono"
import type { AppDeps } from "../app"
import { runEffect } from "../effect-helpers"
import { normalizeTimestamps } from "../helpers"
import { querySystemLogs } from "../../system-log"
import { Effect } from "effect"

export function systemRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.get("/health", (c) => {
    return c.json({ status: "ok", uptime: process.uptime() })
  })

  app.get("/logs", (c) => {
    const level = c.req.query("level")?.split(",").filter(Boolean)
    const logger = c.req.query("logger")?.split(",").filter(Boolean)
    const taskId = c.req.query("taskId") || undefined
    const projectId = c.req.query("project") || undefined
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined
    const since = c.req.query("since") || undefined

    const logs = querySystemLogs(deps.db, { level, logger, taskId, projectId, limit, since })
    return c.json(logs.map(normalizeTimestamps))
  })

  // Clear system logs
  app.delete("/logs", (c) => {
    deps.db.run("DELETE FROM system_logs")
    return c.json({ ok: true })
  })

  // Orphaned worktrees — terminal tasks with worktree_path still set
  app.get("/cleanup/orphans", (c) => {
    return runEffect(c, deps.orphanCleanup.findOrphans())
  })

  app.post("/cleanup/orphans", (c) => {
    return runEffect(c,
      deps.orphanCleanup.cleanupOrphans().pipe(
        Effect.map((cleaned) => ({ cleaned }))
      )
    )
  })

  // Read full config (no credentials)
  app.get("/config", (c) => {
    return c.json(deps.config.config)
  })

  return app
}
