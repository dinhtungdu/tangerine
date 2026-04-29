// Test-only API routes — gated behind TEST_MODE=1 env var.
// Provides seed/reset/webhook-simulation for e2e browser tests.

import { Effect } from "effect"
import { DEFAULT_AGENT_ID } from "@tangerine/shared"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { createLogger } from "../../logger"
import { isTestMode } from "../../config"
import { createTask as dbCreateTask } from "../../db/queries"
import { processWebhookPayload } from "../../integrations/github"
import type { WebhookIssuePayload } from "../../integrations/github"

const log = createLogger("test-api")

/** Fixture shape accepted by POST /api/test/seed */
export interface SeedPayload {
  tasks?: Array<{
    id: string
    project_id: string
    title: string
    status: string
    source?: string
    source_id?: string
    source_url?: string
    description?: string
    provider?: string
    model?: string
    branch?: string
    worktree_path?: string
    type?: string
    pr_url?: string
    error?: string
    created_at?: string
    updated_at?: string
    started_at?: string
    completed_at?: string
  }>
  activity_log?: Array<{
    task_id: string
    type: "lifecycle" | "file" | "system"
    event: string
    content: string
    metadata?: Record<string, unknown>
    timestamp?: string
  }>
  stream_events?: Array<{
    task_id: string
    event_type: string
    event_json: string
    timestamp?: string
  }>
}

export function testRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  // Guard: all routes 404 unless TEST_MODE=1
  app.use("*", async (c, next) => {
    if (!isTestMode()) {
      return c.json({ error: "Test endpoints are only available when TEST_MODE=1" }, 404)
    }
    await next()
  })

  // Seed the database with fixture data
  app.post("/seed", async (c) => {
    const payload = await c.req.json<SeedPayload>()
    const db = deps.db
    let taskCount = 0
    let activityCount = 0
    let sessionCount = 0

    if (payload.tasks) {
      for (const t of payload.tasks) {
        // Use typed createTask, then patch status/timestamps via UPDATE
        const row = Effect.runSync(dbCreateTask(db, {
          id: t.id,
          project_id: t.project_id,
          source: t.source ?? "manual",
          source_id: t.source_id ?? null,
          source_url: t.source_url ?? null,
          title: t.title,
          description: t.description ?? null,
          provider: t.provider ?? DEFAULT_AGENT_ID,
          model: t.model ?? null,
          branch: t.branch ?? null,
        }))

        // Patch fields that createTask doesn't accept (status, timestamps, error, pr_url, worktree_path)
        const patches: string[] = []
        const params: Record<string, string | null> = { $id: row.id }
        if (t.status && t.status !== "created") {
          patches.push("status = $status")
          params.$status = t.status
        }
        if (t.pr_url) { patches.push("pr_url = $pr_url"); params.$pr_url = t.pr_url }
        if (t.error) { patches.push("error = $error"); params.$error = t.error }
        if (t.worktree_path) { patches.push("worktree_path = $worktree_path"); params.$worktree_path = t.worktree_path }
        if (t.created_at) { patches.push("created_at = $created_at"); params.$created_at = t.created_at }
        if (t.updated_at) { patches.push("updated_at = $updated_at"); params.$updated_at = t.updated_at }
        if (t.started_at) { patches.push("started_at = $started_at"); params.$started_at = t.started_at }
        if (t.completed_at) { patches.push("completed_at = $completed_at"); params.$completed_at = t.completed_at }

        if (patches.length > 0) {
          db.prepare(`UPDATE tasks SET ${patches.join(", ")} WHERE id = $id`).run(params)
        }
        taskCount++
      }
    }

    // Direct DB inserts for activity_log and stream_events to preserve fixture timestamps.
    // We bypass logActivity()/insertStreamEvent() because they use DB-default timestamps
    // and logActivity() emits WebSocket events (not wanted during bulk seeding).
    if (payload.activity_log) {
      const stmt = db.prepare(`
        INSERT INTO activity_log (task_id, type, event, content, metadata, timestamp)
        VALUES ($task_id, $type, $event, $content, $metadata, $timestamp)
      `)
      for (const a of payload.activity_log) {
        stmt.run({
          $task_id: a.task_id,
          $type: a.type,
          $event: a.event,
          $content: a.content,
          $metadata: a.metadata ? JSON.stringify(a.metadata) : null,
          $timestamp: a.timestamp ?? new Date().toISOString(),
        })
        activityCount++
      }
    }

    if (payload.stream_events) {
      const stmt = db.prepare(`
        INSERT INTO stream_events (task_id, seq, event_type, event_json, timestamp)
        VALUES ($task_id, $seq, $event_type, $event_json, $timestamp)
      `)
      let seq = 0
      for (const s of payload.stream_events) {
        stmt.run({
          $task_id: s.task_id,
          $seq: seq++,
          $event_type: s.event_type,
          $event_json: s.event_json,
          $timestamp: s.timestamp ?? new Date().toISOString(),
        })
        sessionCount++
      }
    }

    log.info("Seeded test data", { taskCount, activityCount, sessionCount })
    return c.json({ ok: true, seeded: { tasks: taskCount, activity_log: activityCount, stream_events: sessionCount } })
  })

  // Wipe all data from tasks, activity_log, and stream_events
  app.post("/reset", (c) => {
    const db = deps.db
    db.run("DELETE FROM stream_events")
    db.run("DELETE FROM activity_log")
    db.run("DELETE FROM tasks")
    log.info("Reset test data — all tables truncated")
    return c.json({ ok: true })
  })

  // Simulate a GitHub webhook without signature verification.
  // Uses the same shared processing logic as the real /webhooks/github endpoint.
  app.post("/simulate-webhook", async (c) => {
    const body = await c.req.text()
    const payload = JSON.parse(body) as WebhookIssuePayload
    const event = c.req.header("x-github-event") ?? "issues"
    const trigger = deps.config.config.integrations?.github?.trigger

    const result = await processWebhookPayload(
      payload,
      event,
      deps.config.config.projects,
      trigger,
      async (params) => {
        const exit = await Effect.runPromiseExit(deps.taskManager.createTask(params))
        return exit._tag === "Success" ? { id: exit.value.id } : null
      },
    )

    if ("error" in result) {
      return c.json({ error: result.error }, 500)
    }
    if (!result.handled) {
      return c.json({ received: true, ignored: true, reason: result.reason }, 202)
    }
    return c.json({ received: true, taskId: result.taskId }, 202)
  })

  return app
}
