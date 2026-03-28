import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createTestDb } from "./helpers"
import { createApp, type AppDeps } from "../api/app"
import { createTask as dbCreateTask, updateTaskStatus, insertSessionLog } from "../db/queries"
import type { RawConfig } from "../config"

function createMockDeps(db: Database, configOverrides?: Partial<AppDeps["config"]["config"]>): AppDeps {
  const configData = {
    projects: [
      { name: "tangerine", repo: "dinhtungdu/tangerine", defaultBranch: "main", setup: "echo ok", defaultProvider: "claude-code" as const },
    ],
    integrations: {
      github: {
        trigger: { type: "label" as const, value: "tangerine" },
      },
    },
    model: "anthropic/claude-sonnet-4-6",
    models: ["anthropic/claude-sonnet-4-6"],
    ...configOverrides,
  }

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
        return Effect.sync(() => { Effect.runSync(updateTaskStatus(db, taskId, "cancelled")) })
      },
      completeTask(taskId) {
        return Effect.sync(() => { Effect.runSync(updateTaskStatus(db, taskId, "done")) })
      },
      sendPrompt(taskId, text) {
        Effect.runSync(insertSessionLog(db, { task_id: taskId, role: "user", content: text }))
        return Effect.succeed(undefined as void)
      },
      abortTask() { return Effect.succeed(undefined as void) },
      changeConfig() { return Effect.void },
      cleanupTask() { return Effect.void },
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

describe("Test API routes", () => {
  let db: Database
  let app: ReturnType<typeof createApp>["app"]
  const originalTestMode = process.env["TEST_MODE"]

  beforeEach(() => {
    process.env["TEST_MODE"] = "1"
    db = createTestDb()
    const deps = createMockDeps(db)
    app = createApp(deps).app
  })

  afterEach(() => {
    if (originalTestMode === undefined) {
      delete process.env["TEST_MODE"]
    } else {
      process.env["TEST_MODE"] = originalTestMode
    }
  })

  describe("TEST_MODE gating", () => {
    test("returns 404 when TEST_MODE is not set", async () => {
      delete process.env["TEST_MODE"]
      const res = await app.fetch(new Request("http://localhost/api/test/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: [] }),
      }))
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("TEST_MODE")
    })

    test("returns 404 for reset when TEST_MODE is not set", async () => {
      delete process.env["TEST_MODE"]
      const res = await app.fetch(new Request("http://localhost/api/test/reset", { method: "POST" }))
      expect(res.status).toBe(404)
    })

    test("returns 404 for simulate-webhook when TEST_MODE is not set", async () => {
      delete process.env["TEST_MODE"]
      const res = await app.fetch(new Request("http://localhost/api/test/simulate-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(404)
    })
  })

  describe("POST /api/test/seed", () => {
    test("seeds tasks into the database", async () => {
      const res = await app.fetch(new Request("http://localhost/api/test/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: [
            { id: "seed-task-1", project_id: "tangerine", title: "Seeded task one", status: "running" },
            { id: "seed-task-2", project_id: "tangerine", title: "Seeded task two", status: "done", pr_url: "https://github.com/test/repo/pull/1" },
          ],
        }),
      }))
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; seeded: { tasks: number } }
      expect(body.ok).toBe(true)
      expect(body.seeded.tasks).toBe(2)

      // Verify tasks are in the DB with correct status
      const task1 = db.prepare("SELECT * FROM tasks WHERE id = ?").get("seed-task-1") as { status: string; title: string }
      expect(task1.title).toBe("Seeded task one")
      expect(task1.status).toBe("running")

      const task2 = db.prepare("SELECT * FROM tasks WHERE id = ?").get("seed-task-2") as { status: string; pr_url: string }
      expect(task2.status).toBe("done")
      expect(task2.pr_url).toBe("https://github.com/test/repo/pull/1")
    })

    test("seeds activity logs with preserved timestamps and metadata", async () => {
      await app.fetch(new Request("http://localhost/api/test/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: [{ id: "activity-task", project_id: "tangerine", title: "Activity test", status: "running" }],
          activity_log: [
            { task_id: "activity-task", type: "lifecycle", event: "lifecycle:created", content: "Task created", timestamp: "2026-01-15T10:00:00.000Z" },
            { task_id: "activity-task", type: "file", event: "tool.read", content: "Read file.ts", timestamp: "2026-01-15T10:01:00.000Z", metadata: { tool: "Read", path: "file.ts" } },
          ],
        }),
      }))

      const activities = db.prepare("SELECT * FROM activity_log WHERE task_id = ? ORDER BY timestamp ASC").all("activity-task") as Array<{ event: string; timestamp: string; metadata: string | null }>
      expect(activities).toHaveLength(2)
      expect(activities[0]!.event).toBe("lifecycle:created")
      expect(activities[0]!.timestamp).toBe("2026-01-15T10:00:00.000Z")
      expect(activities[1]!.event).toBe("tool.read")
      expect(activities[1]!.timestamp).toBe("2026-01-15T10:01:00.000Z")
      // Metadata should be a JSON string (single-encoded, not double)
      const meta = JSON.parse(activities[1]!.metadata!) as { tool: string; path: string }
      expect(meta.tool).toBe("Read")
      expect(meta.path).toBe("file.ts")
    })

    test("seeds session logs with preserved timestamps", async () => {
      await app.fetch(new Request("http://localhost/api/test/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: [{ id: "session-task", project_id: "tangerine", title: "Session test", status: "running" }],
          session_logs: [
            { task_id: "session-task", role: "user", content: "Hello agent", timestamp: "2026-01-15T10:00:00.000Z" },
            { task_id: "session-task", role: "assistant", content: "Hello! How can I help?", timestamp: "2026-01-15T10:00:05.000Z" },
          ],
        }),
      }))

      const logs = db.prepare("SELECT * FROM session_logs WHERE task_id = ? ORDER BY id").all("session-task") as Array<{ role: string; content: string; timestamp: string }>
      expect(logs).toHaveLength(2)
      expect(logs[0]!.role).toBe("user")
      expect(logs[0]!.timestamp).toBe("2026-01-15T10:00:00.000Z")
      expect(logs[1]!.role).toBe("assistant")
      expect(logs[1]!.timestamp).toBe("2026-01-15T10:00:05.000Z")
    })

    test("seeds empty payload without error", async () => {
      const res = await app.fetch(new Request("http://localhost/api/test/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(200)
      const body = await res.json() as { seeded: { tasks: number; activity_log: number; session_logs: number } }
      expect(body.seeded.tasks).toBe(0)
      expect(body.seeded.activity_log).toBe(0)
      expect(body.seeded.session_logs).toBe(0)
    })
  })

  describe("POST /api/test/reset", () => {
    test("truncates all tables", async () => {
      // Seed some data first
      await app.fetch(new Request("http://localhost/api/test/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: [{ id: "reset-task", project_id: "tangerine", title: "To be reset", status: "done" }],
          session_logs: [{ task_id: "reset-task", role: "user", content: "test" }],
          activity_log: [{ task_id: "reset-task", type: "lifecycle", event: "lifecycle:created", content: "created" }],
        }),
      }))

      // Verify data exists
      expect((db.prepare("SELECT COUNT(*) as c FROM tasks").get() as { c: number }).c).toBeGreaterThan(0)

      // Reset
      const res = await app.fetch(new Request("http://localhost/api/test/reset", { method: "POST" }))
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      // Verify all tables are empty
      expect((db.prepare("SELECT COUNT(*) as c FROM tasks").get() as { c: number }).c).toBe(0)
      expect((db.prepare("SELECT COUNT(*) as c FROM activity_log").get() as { c: number }).c).toBe(0)
      expect((db.prepare("SELECT COUNT(*) as c FROM session_logs").get() as { c: number }).c).toBe(0)
    })
  })

  describe("POST /api/test/simulate-webhook", () => {
    test("creates a task from issue.opened with matching label", async () => {
      const payload = {
        action: "opened",
        issue: {
          number: 42,
          title: "Test issue from webhook",
          body: "Issue body text",
          html_url: "https://github.com/dinhtungdu/tangerine/issues/42",
          labels: [{ name: "tangerine" }],
          assignee: null,
        },
        repository: { full_name: "dinhtungdu/tangerine" },
      }

      const res = await app.fetch(new Request("http://localhost/api/test/simulate-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-github-event": "issues" },
        body: JSON.stringify(payload),
      }))
      expect(res.status).toBe(202)
      const body = await res.json() as { received: boolean; taskId: string }
      expect(body.received).toBe(true)
      expect(body.taskId).toBeDefined()

      // Verify task was created in DB
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(body.taskId) as { title: string; source: string; source_id: string }
      expect(task.title).toBe("Test issue from webhook")
      expect(task.source).toBe("github")
      expect(task.source_id).toBe("github:dinhtungdu/tangerine#42")
    })

    test("ignores webhook with non-matching label", async () => {
      const payload = {
        action: "opened",
        issue: {
          number: 43,
          title: "Ignored issue",
          body: null,
          html_url: "https://github.com/dinhtungdu/tangerine/issues/43",
          labels: [{ name: "unrelated" }],
          assignee: null,
        },
        repository: { full_name: "dinhtungdu/tangerine" },
      }

      const res = await app.fetch(new Request("http://localhost/api/test/simulate-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-github-event": "issues" },
        body: JSON.stringify(payload),
      }))
      expect(res.status).toBe(202)
      const body = await res.json() as { ignored: boolean; reason: string }
      expect(body.ignored).toBe(true)
      expect(body.reason).toContain("label")
    })

    test("ignores webhook for unknown repo", async () => {
      const payload = {
        action: "opened",
        issue: {
          number: 1,
          title: "Unknown repo issue",
          body: null,
          html_url: "https://github.com/other/repo/issues/1",
          labels: [{ name: "tangerine" }],
          assignee: null,
        },
        repository: { full_name: "other/repo" },
      }

      const res = await app.fetch(new Request("http://localhost/api/test/simulate-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-github-event": "issues" },
        body: JSON.stringify(payload),
      }))
      expect(res.status).toBe(202)
      const body = await res.json() as { ignored: boolean; reason: string }
      expect(body.ignored).toBe(true)
      expect(body.reason).toContain("no project matches")
    })

    test("ignores non-actionable event", async () => {
      const payload = {
        action: "closed",
        issue: {
          number: 44,
          title: "Closed issue",
          body: null,
          html_url: "https://github.com/dinhtungdu/tangerine/issues/44",
          labels: [{ name: "tangerine" }],
          assignee: null,
        },
        repository: { full_name: "dinhtungdu/tangerine" },
      }

      const res = await app.fetch(new Request("http://localhost/api/test/simulate-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-github-event": "issues" },
        body: JSON.stringify(payload),
      }))
      expect(res.status).toBe(202)
      const body = await res.json() as { ignored: boolean; reason: string }
      expect(body.ignored).toBe(true)
      expect(body.reason).toContain("not actionable")
    })

    test("defaults x-github-event to issues when header missing", async () => {
      const payload = {
        action: "opened",
        issue: {
          number: 45,
          title: "No header issue",
          body: null,
          html_url: "https://github.com/dinhtungdu/tangerine/issues/45",
          labels: [{ name: "tangerine" }],
          assignee: null,
        },
        repository: { full_name: "dinhtungdu/tangerine" },
      }

      const res = await app.fetch(new Request("http://localhost/api/test/simulate-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }))
      expect(res.status).toBe(202)
      const body = await res.json() as { received: boolean; taskId: string }
      expect(body.received).toBe(true)
      expect(body.taskId).toBeDefined()
    })
  })
})
