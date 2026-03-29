import { describe, test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createTestDb } from "./helpers"
import { tmuxSessionName } from "../api/routes/terminal-ws"
import { createApp, type AppDeps } from "../api/app"
import { createTask as dbCreateTask, updateTaskStatus, insertSessionLog, getTask as dbGetTask } from "../db/queries"
import { TaskNotFoundError } from "../errors"
import type { TaskRow } from "../db/types"
import type { RawConfig } from "../config"

function createMockDeps(db: Database, configOverrides?: Partial<AppDeps["config"]["config"]>): AppDeps {
  const configData = {
    projects: [
      { name: "test-project", repo: "test/repo", defaultBranch: "main", setup: "echo ok", defaultProvider: "opencode" as const },
    ],
    integrations: {},
    model: "openai/gpt-4o",
    models: ["openai/gpt-4o"],
    pool: {
      maxPoolSize: 2,
      minReady: 1,
      idleTimeoutMs: 600_000,
    },
    ...configOverrides,
  }

  // In-memory config store for testing project CRUD
  let rawConfig: RawConfig = {
    projects: configData.projects.map((p) => ({ ...p })),
    model: configData.model,
  }

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
      resolveTask(taskId) {
        return Effect.gen(function* () {
          const task = yield* dbGetTask(db, taskId)
          if (!task) return yield* Effect.fail(new TaskNotFoundError({ taskId }))
          if (task.status !== "failed" && task.status !== "cancelled") {
            return yield* Effect.fail({ _tag: "TaskNotTerminalError" as const, message: `Only failed or cancelled tasks can be resolved (current status: ${task.status})` })
          }
          yield* updateTaskStatus(db, taskId, "done")
        })
      },
      sendPrompt(taskId, text) {
        Effect.runSync(insertSessionLog(db, { task_id: taskId, role: "user", content: text }))
        return Effect.succeed(undefined as void)
      },
      abortTask() { return Effect.succeed(undefined as void) },
      changeConfig(taskId: string, config: { model?: string; reasoningEffort?: string }) {
        return Effect.sync(() => {
          if (config.model) db.prepare("UPDATE tasks SET model = ? WHERE id = ?").run(config.model, taskId)
          if (config.reasoningEffort) db.prepare("UPDATE tasks SET reasoning_effort = ? WHERE id = ?").run(config.reasoningEffort, taskId)
        })
      },
      cleanupTask() { return Effect.void },
      ensureOrchestrator(projectId) {
        const id = crypto.randomUUID()
        const row = Effect.runSync(dbCreateTask(db, {
          id,
          project_id: projectId,
          source: "manual",
          source_id: null,
          source_url: null,
          repo_url: "https://github.com/test/repo",
          title: "_orchestrator",
          description: null,
        }))
        return Effect.succeed(row)
      },
      startTask() { return Effect.void },
      onTaskEvent() { return () => {} },
      onStatusChange() { return () => {} },
    },
    orphanCleanup: {
      findOrphans() { return Effect.succeed([]) },
      cleanupOrphans() { return Effect.succeed(0) },
    },
    configStore: {
      read: () => rawConfig,
      write: (config: RawConfig) => { rawConfig = config },
    },
    config: {
      config: configData as AppDeps["config"]["config"],
      credentials: {
        opencodeAuthPath: null,
        claudeOauthToken: null,
        anthropicApiKey: null,
        githubToken: null,
        serverPort: 3456,
        externalHost: "localhost",
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
  let deps: AppDeps
  let app: ReturnType<typeof createApp>["app"]

  beforeEach(() => {
    db = createTestDb()
    deps = createMockDeps(db)
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

  describe("POST /api/tasks (cross-project)", () => {
    test("creates a cross-project task with source and sourceId", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "test-project",
          title: "Fix bug found in other project",
          description: "Details here",
          source: "cross-project",
          sourceId: "origin-task-123",
        }),
      }))
      expect(res.status).toBe(201)
      const body = await res.json() as { title: string; source: string; sourceId: string }
      expect(body.title).toBe("Fix bug found in other project")
      expect(body.source).toBe("cross-project")
      expect(body.sourceId).toBe("origin-task-123")
    })

    test("defaults to manual source when source not specified", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "test-project",
          title: "Regular task",
        }),
      }))
      expect(res.status).toBe(201)
      const body = await res.json() as { source: string }
      expect(body.source).toBe("manual")
    })
  })

  describe("DELETE /api/tasks/:id", () => {
    test("deletes a terminal task", async () => {
      const row = seedTask(db)
      Effect.runSync(updateTaskStatus(db, row.id, "done"))

      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}`, { method: "DELETE" }))
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      // Verify task is gone
      const check = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}`))
      expect(check.status).toBe(404)
    })

    test("returns 400 for non-terminal task", async () => {
      const row = seedTask(db)
      // status is 'created' (non-terminal)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}`, { method: "DELETE" }))
      expect(res.status).toBe(400)
    })

    test("returns 404 for unknown task", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks/nonexistent", { method: "DELETE" }))
      expect(res.status).toBe(404)
    })
  })

  describe("POST /api/tasks/:id/resolve", () => {
    test("transitions a failed task to done", async () => {
      const row = seedTask(db)
      Effect.runSync(updateTaskStatus(db, row.id, "failed"))

      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/resolve`, { method: "POST" }))
      expect(res.status).toBe(200)

      const check = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}`))
      const body = await check.json() as { status: string }
      expect(body.status).toBe("done")
    })

    test("transitions a cancelled task to done", async () => {
      const row = seedTask(db)
      Effect.runSync(updateTaskStatus(db, row.id, "cancelled"))

      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/resolve`, { method: "POST" }))
      expect(res.status).toBe(200)

      const check = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}`))
      const body = await check.json() as { status: string }
      expect(body.status).toBe("done")
    })

    test("returns 400 for non-terminal task", async () => {
      const row = seedTask(db)
      // status is "created" (non-terminal)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/resolve`, { method: "POST" }))
      expect(res.status).toBe(400)
    })

    test("returns 404 for unknown task", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks/nonexistent/resolve", { method: "POST" }))
      expect(res.status).toBe(404)
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

  describe("POST /api/tasks/:id/chat", () => {
    test("sends a prompt and persists user message", async () => {
      const row = seedTask(db)

      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello agent" }),
      }))
      expect(res.status).toBe(202)
      const body = await res.json() as { ok: boolean; taskId: string }
      expect(body.ok).toBe(true)
      expect(body.taskId).toBe(row.id)

      // Verify user message was persisted
      const msgs = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/messages`))
      const messages = await msgs.json() as Array<{ role: string; content: string }>
      expect(messages).toHaveLength(1)
      expect(messages[0]!.role).toBe("user")
      expect(messages[0]!.content).toBe("Hello agent")
    })

    test("returns 400 without text", async () => {
      const row = seedTask(db)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    test("returns 404 for unknown task", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks/nonexistent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      }))
      expect(res.status).toBe(404)
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

  describe("POST /api/tasks/:id/model", () => {
    test("changes model for a task", async () => {
      const row = seedTask(db)
      db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(row.id)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-6" }),
      }))
      expect(res.status).toBe(200)
      const updated = db.prepare("SELECT model FROM tasks WHERE id = ?").get(row.id) as { model: string }
      expect(updated.model).toBe("claude-opus-4-6")
    })

    test("changes reasoning effort for a task", async () => {
      const row = seedTask(db)
      db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(row.id)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasoningEffort: "high" }),
      }))
      expect(res.status).toBe(200)
      const updated = db.prepare("SELECT reasoning_effort FROM tasks WHERE id = ?").get(row.id) as { reasoning_effort: string }
      expect(updated.reasoning_effort).toBe("high")
    })

    test("returns 400 without model or reasoningEffort", async () => {
      const row = seedTask(db)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })
  })

  describe("GET /api/config", () => {
    test("returns full config without credentials", async () => {
      const res = await app.fetch(new Request("http://localhost/api/config"))
      expect(res.status).toBe(200)
      const body = await res.json() as { projects: unknown[]; model: string }
      expect(body.projects).toHaveLength(1)
      expect(body.model).toBe("openai/gpt-4o")
      // Ensure no credential fields leak
      expect("credentials" in body).toBe(false)
    })
  })

  describe("DELETE /api/logs", () => {
    test("clears system logs", async () => {
      // Seed a log entry
      db.run("INSERT INTO system_logs (level, logger, message, timestamp) VALUES ('info', 'test', 'hello', datetime('now'))")
      const before = db.query("SELECT COUNT(*) as cnt FROM system_logs").get() as { cnt: number }
      expect(before.cnt).toBeGreaterThan(0)

      const res = await app.fetch(new Request("http://localhost/api/logs", { method: "DELETE" }))
      expect(res.status).toBe(200)

      const after = db.query("SELECT COUNT(*) as cnt FROM system_logs").get() as { cnt: number }
      expect(after.cnt).toBe(0)
    })
  })

  describe("POST /api/projects", () => {
    test("registers a new project", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "new-project",
          repo: "https://github.com/test/new",
          image: "node-dev",
          setup: "npm install",
        }),
      }))
      expect(res.status).toBe(201)
      const body = await res.json() as { name: string }
      expect(body.name).toBe("new-project")

      // Verify it appears in project list
      expect(deps.config.config.projects).toHaveLength(2)
    })

    test("returns 409 for duplicate project", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test-project",
          repo: "test/repo",
          image: "test",
          setup: "echo ok",
        }),
      }))
      expect(res.status).toBe(409)
    })

    test("returns 400 for invalid project config", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad" }),
      }))
      expect(res.status).toBe(400)
    })
  })

  describe("PUT /api/projects/:name", () => {
    test("updates a project", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects/test-project", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setup: "npm run dev" }),
      }))
      expect(res.status).toBe(200)
      const body = await res.json() as { name: string; setup: string }
      expect(body.name).toBe("test-project")
      expect(body.setup).toBe("npm run dev")
    })

    test("returns 404 for unknown project", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects/nonexistent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setup: "npm run dev" }),
      }))
      expect(res.status).toBe(404)
    })

    test("name is immutable", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects/test-project", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "renamed" }),
      }))
      expect(res.status).toBe(200)
      const body = await res.json() as { name: string }
      expect(body.name).toBe("test-project")
    })
  })

  describe("DELETE /api/projects/:name", () => {
    test("returns 400 when removing last project", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects/test-project", { method: "DELETE" }))
      expect(res.status).toBe(400)
    })

    test("removes a project when multiple exist", async () => {
      // Add a second project first
      await app.fetch(new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "second-project",
          repo: "https://github.com/test/second",
          image: "node-dev",
          setup: "npm install",
        }),
      }))
      expect(deps.config.config.projects).toHaveLength(2)

      const res = await app.fetch(new Request("http://localhost/api/projects/test-project", { method: "DELETE" }))
      expect(res.status).toBe(200)
      expect(deps.config.config.projects).toHaveLength(1)
      expect(deps.config.config.projects[0]!.name).toBe("second-project")
    })

    test("returns 404 for unknown project", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects/nonexistent", { method: "DELETE" }))
      expect(res.status).toBe(404)
    })
  })

  describe("tmuxSessionName", () => {
    test("uses first 8 chars of task ID with tng- prefix", () => {
      expect(tmuxSessionName("b1c01db0-3c2a-4735-9534-b12d33ec34f8")).toBe("tng-b1c01db0")
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
