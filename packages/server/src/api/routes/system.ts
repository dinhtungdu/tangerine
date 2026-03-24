import { existsSync, readFileSync, statSync } from "fs"
import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { normalizeTimestamps } from "../helpers"
import { listImages } from "../../db/queries"
import { querySystemLogs } from "../../system-log"
import { buildLogPath } from "../../image/build"

export function systemRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.get("/health", (c) => {
    return c.json({ status: "ok", uptime: process.uptime() })
  })

  app.get("/pool", (c) => {
    return runEffect(c, deps.pool.getPoolStats())
  })

  app.get("/vms", (c) => {
    const project = c.req.query("project") || undefined
    return runEffect(c,
      Effect.sync(() => {
        const conditions = ["status != 'destroyed'"]
        const params: Record<string, string> = {}
        if (project) {
          conditions.push("project_id = $project")
          params.$project = project
        }
        const rows = deps.db.prepare(`
          SELECT *
          FROM vms
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at DESC
        `).all(params) as Array<{ id: string; status: string; ip: string | null; project_id: string; provider: string; created_at: string }>
        return rows.map((r) => ({
          id: r.id,
          status: r.status,
          ip: r.ip,
          projectId: r.project_id,
          provider: r.provider,
          createdAt: r.created_at,
        }))
      })
    )
  })

  // Provision a VM for a project (creates from base image if none exists)
  app.post("/vms/provision", async (c) => {
    const body = await c.req.json<{ projectId?: string }>().catch(() => ({ projectId: undefined }))
    const projectId = body.projectId || c.req.query("project")
    if (!projectId) {
      return c.json({ error: "projectId is required" }, 400)
    }
    return runEffect(c,
      deps.pool.provisionVm(projectId).pipe(
        Effect.map((vm) => ({ id: vm.id, status: vm.status, ip: vm.ip }))
      ),
      { status: 201 }
    )
  })

  // Destroy a VM by ID, reprovision affected tasks, and restart them
  app.delete("/vms/:id", (c) => {
    const vmId = c.req.param("id")
    return runEffect(c, Effect.gen(function* () {
      yield* deps.pool.destroyVm(vmId)
      const result = yield* deps.pool.reprovisionTasksForVm(vmId)
      if (result.reprovisioned > 0) {
        // Fire-and-forget — daemons need to outlive the request
        Effect.runPromise(deps.pool.resumeOrphanedTasks()).catch(() => {})
      }
      return result
    }))
  })

  // Force pool reconciliation
  app.post("/pool/reconcile", (c) => {
    return runEffectVoid(c, deps.pool.reconcile())
  })

  // Returns the latest golden image for a project (or all if no project)
  app.get("/images", (c) => {
    const project = c.req.query("project") || undefined
    return runEffect(c,
      listImages(deps.db).pipe(
        Effect.map((rows) => {
          const mapped = rows.map((r) => ({
            id: r.id,
            name: r.name,
            provider: r.provider,
            snapshotId: r.snapshot_id,
            createdAt: r.created_at,
          }))

          if (!project) return mapped

          // Match by project's configured image name, return only the latest
          const projectConfig = deps.config.config.projects.find((p) => p.name === project)
          if (!projectConfig) return []

          const matching = mapped
            .filter((r) => r.name === projectConfig.image)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

          return matching.slice(0, 1)
        })
      )
    )
  })

  app.post("/images/build-base", (c) => {
    const result = deps.imageBuild.startBase()
    if (!result.ok) {
      return c.json({ error: result.reason }, 409)
    }
    return c.json({ status: "building", imageName: "base" }, 202)
  })

  app.get("/images/build-status", (c) => {
    return c.json(deps.imageBuild.getStatus())
  })

  app.get("/images/build-log", (c) => {
    const project = c.req.query("project") || undefined
    const projectConfig = project
      ? deps.config.config.projects.find((p) => p.name === project)
      : deps.config.config.projects[0]
    const imageName = projectConfig?.image
    if (!imageName) {
      return c.text("No project configured", 400)
    }
    const logPath = buildLogPath(imageName)
    if (!existsSync(logPath)) {
      return c.text("No build log available", 404)
    }
    // Support tailing: ?offset=<bytes> returns content from that byte offset
    const offset = Number(c.req.query("offset") ?? "0")
    const size = statSync(logPath).size
    const content = offset < size
      ? readFileSync(logPath, "utf-8").slice(offset)
      : ""
    return c.json({ content, size })
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

  // Re-read credentials from dotfile/env and re-inject into all running VMs
  app.post("/credentials/refresh", (c) => {
    return runEffect(c, deps.refreshCredentials())
  })

  // Read full config (no credentials)
  app.get("/config", (c) => {
    return c.json(deps.config.config)
  })

  return app
}
