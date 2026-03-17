import { describe, test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createTestDb } from "./helpers"
import { createApp, type AppDeps } from "../api/app"
import { createTask as dbCreateTask, updateTaskStatus } from "../db/queries"
import type { TaskRow } from "../db/types"

function createMockDeps(db: Database): AppDeps {
  return {
    db,
    taskManager: {
      createTask(params) {
        const id = crypto.randomUUID()
        const row = Effect.runSync(dbCreateTask(db, {
          id,
          project_id: params.projectId,
          source: params.source,
          source_id: params.sourceId ?? null,
          source_url: params.sourceUrl ?? null,
          repo_url: "https://github.com/test/repo",
          title: params.title,
          description: params.description ?? null,
        }))
        return Effect.succeed(row)
      },
      cancelTask(taskId) {
        return Effect.sync(() => {
          Effect.runSync(updateTaskStatus(db, taskId, "cancelled"))
        })
      },
      completeTask(taskId) {
        return Effect.sync(() => {
          Effect.runSync(updateTaskStatus(db, taskId, "done"))
        })
      },
      sendPrompt() { return Effect.succeed(undefined as void) },
      abortTask() { return Effect.succeed(undefined as void) },
      onTaskEvent() { return () => {} },
      onStatusChange() { return () => {} },
    },
    pool: {
      getPoolStats() {
        return Effect.succeed({ ready: 2, assigned: 1, provisioning: 0, total: 3 })
      },
    },
    config: {
      config: {
        projects: [
          { name: "test-project", repo: "test/repo", defaultBranch: "main", image: "test", setup: "echo ok" },
        ],
        integrations: {},
        model: "openai/gpt-4o",
        models: ["openai/gpt-4o"],
      },
      credentials: {
        opencodeAuthPath: null,
        anthropicApiKey: null,
        githubToken: null,
        ghHost: "github.com",
      },
    } satisfies AppDeps["config"],
  }
}

function seedTask(db: Database, overrides?: Partial<Parameters<typeof dbCreateTask>[1]>): TaskRow {
  return Effect.runSync(dbCreateTask(db, {
    id: crypto.randomUUID(),
    project_id: "test-project",
    source: "manual",
    source_id: null,
    source_url: null,
    repo_url: "https://github.com/test/repo",
    title: "Test task",
    description: null,
    ...overrides,
  }))
}

describe("API routes", () => {
  let db: Database
  let app: ReturnType<typeof createApp>["app"]

  beforeEach(() => {
    db = createTestDb()
    const deps = createMockDeps(db)
    app = createApp(deps).app
  })

  describe("GET /api/health", () => {
    test("returns ok", async () => {
      const res = await app.fetch(new Request("http://localhost/api/health"))
      expect(res.status).toBe(200)
      const body = await res.json() as { status: string }
      expect(body.status).toBe("ok")
    })
  })

  describe("GET /api/pool", () => {
    test("returns pool stats", async () => {
      const res = await app.fetch(new Request("http://localhost/api/pool"))
      expect(res.status).toBe(200)
      const body = await res.json() as { ready: number; total: number }
      expect(body.ready).toBe(2)
      expect(body.total).toBe(3)
    })
  })

  describe("GET /api/tasks", () => {
    test("returns empty array when no tasks", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks"))
      expect(res.status).toBe(200)
      const body = await res.json() as unknown[]
      expect(body).toEqual([])
    })

    test("returns tasks", async () => {
      seedTask(db, { title: "Task A" })
      seedTask(db, { title: "Task B" })

      const res = await app.fetch(new Request("http://localhost/api/tasks"))
      expect(res.status).toBe(200)
      const body = await res.json() as Array<{ title: string }>
      expect(body).toHaveLength(2)
    })

    test("filters by project", async () => {
      seedTask(db, { title: "Match", project_id: "test-project" })
      seedTask(db, { title: "Other", project_id: "other-project" })

      const res = await app.fetch(new Request("http://localhost/api/tasks?project=test-project"))
      const body = await res.json() as Array<{ title: string }>
      expect(body).toHaveLength(1)
      expect(body[0]!.title).toBe("Match")
    })
  })

  describe("GET /api/tasks/:id", () => {
    test("returns task by id", async () => {
      const row = seedTask(db, { title: "My Task" })

      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}`))
      expect(res.status).toBe(200)
      const body = await res.json() as { id: string; title: string }
      expect(body.id).toBe(row.id)
      expect(body.title).toBe("My Task")
    })

    test("returns 404 for unknown task", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks/nonexistent"))
      expect(res.status).toBe(404)
    })
  })

  describe("POST /api/tasks", () => {
    test("creates a task", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", title: "New task" }),
      }))
      expect(res.status).toBe(201)
      const body = await res.json() as { title: string; status: string }
      expect(body.title).toBe("New task")
      expect(body.status).toBe("created")
    })

    test("returns 400 without title", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project" }),
      }))
      expect(res.status).toBe(400)
    })

    test("returns 400 for unknown project", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "nonexistent", title: "Task" }),
      }))
      expect(res.status).toBe(400)
    })
  })

  describe("GET /api/tasks/:id/messages", () => {
    test("returns empty messages for new task", async () => {
      const row = seedTask(db)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/messages`))
      expect(res.status).toBe(200)
      const body = await res.json() as unknown[]
      expect(body).toEqual([])
    })
  })

  describe("POST /api/tasks/:id/prompt", () => {
    test("returns 400 without text", async () => {
      const row = seedTask(db)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })
  })

  describe("response format", () => {
    test("task response uses camelCase", async () => {
      const row = seedTask(db)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}`))
      const body = await res.json() as Record<string, unknown>

      // camelCase keys
      expect("projectId" in body).toBe(true)
      expect("createdAt" in body).toBe(true)
      expect("updatedAt" in body).toBe(true)

      // no snake_case keys
      expect("project_id" in body).toBe(false)
      expect("created_at" in body).toBe(false)
    })
  })
})
