// Test-only API routes — gated behind TEST_MODE=1 env var.
// Provides seed/reset/webhook-simulation for e2e browser tests.

import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { createLogger } from "../../logger"
import { isTestMode } from "../../config"

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
    repo_url?: string
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
    type: string
    event: string
    content: string
    metadata?: string
    timestamp?: string
  }>
  session_logs?: Array<{
    task_id: string
    role: string
    content: string
    images?: string
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
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO tasks (id, project_id, title, status, source, source_id, source_url, repo_url,
          description, provider, model, branch, worktree_path, type, pr_url, error,
          created_at, updated_at, started_at, completed_at)
        VALUES ($id, $project_id, $title, $status, $source, $source_id, $source_url, $repo_url,
          $description, $provider, $model, $branch, $worktree_path, $type, $pr_url, $error,
          $created_at, $updated_at, $started_at, $completed_at)
      `)
      for (const t of payload.tasks) {
        const now = new Date().toISOString()
        stmt.run({
          $id: t.id,
          $project_id: t.project_id,
          $title: t.title,
          $status: t.status,
          $source: t.source ?? "manual",
          $source_id: t.source_id ?? null,
          $source_url: t.source_url ?? null,
          $repo_url: t.repo_url ?? "https://github.com/test/repo",
          $description: t.description ?? null,
          $provider: t.provider ?? "claude-code",
          $model: t.model ?? null,
          $branch: t.branch ?? null,
          $worktree_path: t.worktree_path ?? null,
          $type: t.type ?? "code",
          $pr_url: t.pr_url ?? null,
          $error: t.error ?? null,
          $created_at: t.created_at ?? now,
          $updated_at: t.updated_at ?? now,
          $started_at: t.started_at ?? null,
          $completed_at: t.completed_at ?? null,
        })
        taskCount++
      }
    }

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
          $metadata: a.metadata ?? null,
          $timestamp: a.timestamp ?? new Date().toISOString(),
        })
        activityCount++
      }
    }

    if (payload.session_logs) {
      const stmt = db.prepare(`
        INSERT INTO session_logs (task_id, role, content, images, timestamp)
        VALUES ($task_id, $role, $content, $images, $timestamp)
      `)
      for (const s of payload.session_logs) {
        stmt.run({
          $task_id: s.task_id,
          $role: s.role,
          $content: s.content,
          $images: s.images ?? null,
          $timestamp: s.timestamp ?? new Date().toISOString(),
        })
        sessionCount++
      }
    }

    log.info("Seeded test data", { taskCount, activityCount, sessionCount })
    return c.json({ ok: true, seeded: { tasks: taskCount, activity_log: activityCount, session_logs: sessionCount } })
  })

  // Wipe all data from tasks, activity_log, and session_logs
  app.post("/reset", (c) => {
    const db = deps.db
    db.run("DELETE FROM session_logs")
    db.run("DELETE FROM activity_log")
    db.run("DELETE FROM tasks")
    log.info("Reset test data — all tables truncated")
    return c.json({ ok: true })
  })

  // Simulate a GitHub webhook without signature verification.
  // Accepts the same payload format as the real /webhooks/github endpoint.
  app.post("/simulate-webhook", async (c) => {
    const body = await c.req.text()
    const payload = JSON.parse(body) as {
      action: string
      issue?: {
        number: number
        title: string
        body: string | null
        html_url: string
        labels: Array<{ name: string }>
        assignee: { login: string } | null
      }
      repository?: { full_name: string }
    }

    // Default to "issues" event if not provided via header
    const event = c.req.header("x-github-event") ?? "issues"
    if (event !== "issues" || !payload.issue || !payload.repository) {
      return c.json({ received: true, ignored: true, reason: "not an issue event" }, 202)
    }

    const actionableActions = ["opened", "labeled", "assigned"]
    if (!actionableActions.includes(payload.action)) {
      return c.json({ received: true, ignored: true, reason: `action '${payload.action}' not actionable` }, 202)
    }

    const repoFullName = payload.repository.full_name
    const project = deps.config.config.projects.find((p) => {
      return p.repo === repoFullName || p.repo.endsWith(`/${repoFullName}`) || p.repo.endsWith(`/${repoFullName}.git`)
    })

    if (!project) {
      return c.json({ received: true, ignored: true, reason: `no project matches repo '${repoFullName}'` }, 202)
    }

    // Apply trigger filter if configured
    const trigger = deps.config.config.integrations?.github?.trigger
    if (trigger) {
      const issue = payload.issue
      if (trigger.type === "label" && !issue.labels.some((l) => l.name === trigger.value)) {
        return c.json({ received: true, ignored: true, reason: `label '${trigger.value}' not found` }, 202)
      }
      if (trigger.type === "assignee" && issue.assignee?.login !== trigger.value) {
        return c.json({ received: true, ignored: true, reason: `assignee '${trigger.value}' not matched` }, 202)
      }
    }

    const issue = payload.issue
    const sourceId = `github:${repoFullName}#${issue.number}`

    const result = await Effect.runPromiseExit(
      deps.taskManager.createTask({
        source: "github",
        projectId: project.name,
        title: issue.title,
        description: issue.body ?? undefined,
        sourceId,
        sourceUrl: issue.html_url,
      })
    )

    if (result._tag === "Failure") {
      log.error("Simulated webhook task creation failed", { repo: repoFullName, issue: issue.number })
      return c.json({ error: "Task creation failed" }, 500)
    }

    log.info("Task created from simulated webhook", { taskId: result.value.id, issue: issue.number })
    return c.json({ received: true, taskId: result.value.id }, 202)
  })

  return app
}
