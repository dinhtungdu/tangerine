import { describe, it, expect, beforeEach } from "bun:test"
import type { Database } from "bun:sqlite"
import { Effect } from "effect"
import { Hono } from "hono"
import { createTestDb } from "./helpers"
import { createTask, getTask, listTasks, updateTaskStatus } from "../db/queries"
import { mapTaskRow } from "../api/helpers"
import type { Task } from "@tangerine/shared"
import type { TaskRow } from "../db/types"

/**
 * Tracer bullet: Config -> DB -> API response
 *
 * Validates the full data path: DB schema -> query functions ->
 * route handlers -> JSON serialization -> camelCase mapping.
 */
describe("tracer: config -> db -> api", () => {
  let db: Database
  let app: Hono

  beforeEach(() => {
    db = createTestDb()

    // Build a Hono app that mirrors the route structure
    app = new Hono()

    app.get("/api/health", (c) => {
      return c.json({ status: "ok", uptime: process.uptime() })
    })

    app.get("/api/tasks", (c) => {
      const status = c.req.query("status")
      const rows = Effect.runSync(listTasks(db, status ? { status } : undefined))
      return c.json(rows.map(mapTaskRow))
    })

    app.get("/api/tasks/:id", (c) => {
      const row = Effect.runSync(getTask(db, c.req.param("id")))
      if (!row) {
        return c.json({ error: "Task not found" }, 404)
      }
      return c.json(mapTaskRow(row))
    })

    app.post("/api/tasks", async (c) => {
      const body = await c.req.json<{ title?: string; description?: string }>()
      if (!body.title) {
        return c.json({ error: "title is required" }, 400)
      }
      const id = crypto.randomUUID()
      const row = Effect.runSync(createTask(db, {
        id,
        project_id: "test",
        source: "manual",
        repo_url: "https://github.com/test/repo",
        title: body.title,
        description: body.description,
      }))
      return c.json(mapTaskRow(row), 201)
    })

    app.post("/api/tasks/:id/cancel", async (c) => {
      const id = c.req.param("id")
      const row = Effect.runSync(getTask(db, id))
      if (!row) {
        return c.json({ error: "Task not found" }, 404)
      }
      Effect.runSync(updateTaskStatus(db, id, "cancelled"))
      const updated = Effect.runSync(getTask(db, id))!
      return c.json(mapTaskRow(updated))
    })
  })

  it("GET /api/tasks returns tasks with camelCase field mapping", async () => {
    Effect.runSync(createTask(db, {
      id: "task-abc",
      project_id: "test",
      source: "github",
      repo_url: "https://github.com/test/repo",
      title: "Fix the bug",
      source_id: "test/repo#42",
      source_url: "https://github.com/test/repo/issues/42",
      description: "Something is broken",
    }))

    const res = await app.request("/api/tasks")
    expect(res.status).toBe(200)

    const tasks = (await res.json()) as Task[]
    expect(tasks).toHaveLength(1)

    const task = tasks[0]!
    // Verify camelCase mapping from snake_case DB columns
    expect(task.id).toBe("task-abc")
    expect(task.source).toBe("github")
    expect(task.sourceId).toBe("test/repo#42")
    expect(task.sourceUrl).toBe("https://github.com/test/repo/issues/42")
    expect(task.title).toBe("Fix the bug")
    expect(task.description).toBe("Something is broken")
    expect(task.status).toBe("created")
    expect(task.branch).toBeNull()
    expect(task.prUrl).toBeNull()
    expect(task.createdAt).toBeDefined()
    expect(task.updatedAt).toBeDefined()
  })

  it("GET /api/tasks/:id returns a single task", async () => {
    Effect.runSync(createTask(db, {
      id: "task-single",
      project_id: "test",
      source: "manual",
      repo_url: "https://github.com/test/repo",
      title: "Single task",
    }))

    const res = await app.request("/api/tasks/task-single")
    expect(res.status).toBe(200)

    const task = (await res.json()) as Task
    expect(task.id).toBe("task-single")
    expect(task.title).toBe("Single task")
    expect(task.source).toBe("manual")
  })

  it("GET /api/tasks/:id returns 404 for non-existent task", async () => {
    const res = await app.request("/api/tasks/nonexistent")
    expect(res.status).toBe(404)

    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("Task not found")
  })

  it("POST /api/tasks creates a task and returns it", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "New task from API",
        description: "Created via POST",
      }),
    })

    expect(res.status).toBe(201)

    const task = (await res.json()) as Task
    expect(task.id).toBeDefined()
    expect(task.title).toBe("New task from API")
    expect(task.description).toBe("Created via POST")
    expect(task.source).toBe("manual")
    expect(task.status).toBe("created")

    // Verify task was persisted in DB
    const dbRow = Effect.runSync(getTask(db, task.id))
    expect(dbRow).not.toBeNull()
    expect(dbRow!.title).toBe("New task from API")
  })

  it("POST /api/tasks returns 400 when title missing", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "No title" }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("required")
  })

  it("POST /api/tasks/:id/cancel updates task status", async () => {
    Effect.runSync(createTask(db, {
      id: "task-cancel",
      project_id: "test",
      source: "manual",
      repo_url: "https://github.com/test/repo",
      title: "Cancel me",
    }))

    const res = await app.request("/api/tasks/task-cancel/cancel", {
      method: "POST",
    })

    expect(res.status).toBe(200)

    const task = (await res.json()) as Task
    expect(task.id).toBe("task-cancel")
    expect(task.status).toBe("cancelled")
  })

  it("POST /api/tasks/:id/cancel returns 404 for non-existent task", async () => {
    const res = await app.request("/api/tasks/ghost/cancel", {
      method: "POST",
    })
    expect(res.status).toBe(404)
  })

  it("GET /api/health returns ok", async () => {
    const res = await app.request("/api/health")
    expect(res.status).toBe(200)

    const body = (await res.json()) as { status: string; uptime: number }
    expect(body.status).toBe("ok")
    expect(typeof body.uptime).toBe("number")
  })

  it("GET /api/tasks filters by status query param", async () => {
    Effect.runSync(createTask(db, {
      id: "t-created",
      project_id: "test",
      source: "manual",
      repo_url: "r",
      title: "Created",
    }))
    Effect.runSync(createTask(db, {
      id: "t-running",
      project_id: "test",
      source: "manual",
      repo_url: "r",
      title: "Running",
    }))
    Effect.runSync(updateTaskStatus(db, "t-running", "running"))

    const resAll = await app.request("/api/tasks")
    const all = (await resAll.json()) as Task[]
    expect(all).toHaveLength(2)

    const resCreated = await app.request("/api/tasks?status=created")
    const created = (await resCreated.json()) as Task[]
    expect(created).toHaveLength(1)
    expect(created[0]!.id).toBe("t-created")

    const resRunning = await app.request("/api/tasks?status=running")
    const running = (await resRunning.json()) as Task[]
    expect(running).toHaveLength(1)
    expect(running[0]!.id).toBe("t-running")
  })

  it("mapTaskRow converts all snake_case fields to camelCase", () => {
    const row: TaskRow = {
      id: "test-id",
      project_id: "test",
      source: "github",
      source_id: "owner/repo#1",
      source_url: "https://github.com/owner/repo/issues/1",
      repo_url: "https://github.com/owner/repo",
      title: "Test",
      description: "desc",
      status: "running",
      provider: "opencode",
      model: null,
      reasoning_effort: null,
      branch: "feat/test",
      worktree_path: null,
      pr_url: "https://github.com/owner/repo/pull/1",
      user_id: "user-1",
      agent_session_id: "session-1",
      agent_pid: 12345,
      preview_url: "http://localhost:3000",
      diff_snapshot: null,
      error: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T01:00:00Z",
      started_at: "2025-01-01T00:30:00Z",
      completed_at: null,
    }

    const mapped = mapTaskRow(row)

    expect(mapped.provider).toBe("opencode")
    expect(mapped.sourceId).toBe("owner/repo#1")
    expect(mapped.sourceUrl).toBe("https://github.com/owner/repo/issues/1")
    expect(mapped.prUrl).toBe("https://github.com/owner/repo/pull/1")
    expect(mapped.userId).toBe("user-1")
    expect(mapped.agentSessionId).toBe("session-1")
    expect(mapped.agentPid).toBe(12345)
    expect(mapped.previewUrl).toBe("http://localhost:3000")
    expect(mapped.createdAt).toBe("2025-01-01T00:00:00Z")
    expect(mapped.updatedAt).toBe("2025-01-01T01:00:00Z")
    expect(mapped.startedAt).toBe("2025-01-01T00:30:00Z")
    expect(mapped.completedAt).toBeNull()
  })
})
