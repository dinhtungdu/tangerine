import { describe, test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Database } from "bun:sqlite"
import { createTestDb } from "./helpers"
import { isLoopbackHost, isPublicApiPath } from "../auth"
import { createApp, type AppDeps } from "../api/app"
import { createTask as dbCreateTask, updateTaskStatus, insertSessionLog, getTask as dbGetTask } from "../db/queries"
import { TaskNotFoundError } from "../errors"
import type { TaskRow } from "../db/types"
import type { RawConfig } from "../config"
import { createAgentFactories } from "../agent/factories"
import { getTaskState } from "../tasks/task-state"
import { clearQueue, enqueue } from "../agent/prompt-queue"
import { cleanGitEnv } from "../git-env"

function createMockDeps(db: Database, configOverrides?: Partial<AppDeps["config"]["config"]>): AppDeps {
  const configData = {
    projects: [
      { name: "test-project", repo: "test/repo", defaultBranch: "main", setup: "echo ok", defaultAgent: "acp" },
    ],
    agents: [{ id: "acp", name: "ACP", command: "acp-agent" }],
    defaultAgent: "acp",
    integrations: {},
    model: "openai/gpt-4o",
    models: ["openai/gpt-4o"],
    workspace: "/tmp/tangerine-test-workspace",
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
          title: params.title,
          description: params.description ?? null,
          pr_url: params.prUrl ?? null,
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
      changeConfig(taskId: string, config: { model?: string; reasoningEffort?: string; mode?: string }) {
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
          title: "_orchestrator",
          type: "orchestrator",
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
        tangerineAuthToken: null,
        serverPort: 3456,
        externalHost: "localhost",
        ssl: null,
      },
    } satisfies AppDeps["config"],
    getAgentHandle: () => null,
    agentFactories: createAgentFactories({ agents: configData.agents }),
    systemCapabilities: {
      git: { available: true },
      gh: { available: true, authenticated: true },
      providers: {
        acp: { available: true, cliCommand: "acp-agent" },
      },
    },
  }
}

function seedTask(db: Database, overrides?: Partial<Parameters<typeof dbCreateTask>[1]>): TaskRow {
  return Effect.runSync(dbCreateTask(db, {
    id: crypto.randomUUID(),
    project_id: "test-project",
    source: "manual",
    source_id: null,
    source_url: null,
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

  describe("isLoopbackHost", () => {
    test("accepts the full IPv4 loopback range", () => {
      expect(isLoopbackHost("127.0.0.1")).toBe(true)
      expect(isLoopbackHost("127.0.1.1")).toBe(true)
      expect(isLoopbackHost("127.255.255.255")).toBe(true)
    })

    test("accepts IPv6 loopback forms", () => {
      expect(isLoopbackHost("::1")).toBe(true)
      expect(isLoopbackHost("[::1]")).toBe(true)
      expect(isLoopbackHost("0:0:0:0:0:0:0:1")).toBe(true)
    })

    test("rejects non-loopback hosts", () => {
      expect(isLoopbackHost("0.0.0.0")).toBe(false)
      expect(isLoopbackHost("192.168.1.5")).toBe(false)
      expect(isLoopbackHost("example.com")).toBe(false)
    })
  })

  describe("file mention routes", () => {
    test("lists project repo files filtered by query", async () => {
      const workspace = join(tmpdir(), `tangerine-files-${crypto.randomUUID()}`)
      const repoDir = join(workspace, "test-project", "0")
      try {
        mkdirSync(join(repoDir, "web", "src"), { recursive: true })
        writeFileSync(join(repoDir, "web", "src", "ChatInput.tsx"), "export const ok = true\n")
        writeFileSync(join(repoDir, "README.md"), "docs\n")
        Bun.spawnSync(["git", "init", repoDir], { env: cleanGitEnv() })
        Bun.spawnSync(["git", "-C", repoDir, "add", "."], { env: cleanGitEnv() })
        Bun.spawnSync(["git", "-C", repoDir, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], { env: cleanGitEnv() })
        writeFileSync(join(repoDir, "web", "src", "UntrackedOnly.tsx"), "export const local = true\n")
        deps = createMockDeps(db, { workspace })
        app = createApp(deps).app

        const res = await app.fetch(new Request("http://localhost/api/projects/test-project/files?query=Chat"))
        expect(res.status).toBe(200)
        const body = await res.json() as { files: Array<{ path: string }> }
        expect(body.files).toEqual([{ path: "web/src/ChatInput.tsx" }])

        const untrackedRes = await app.fetch(new Request("http://localhost/api/projects/test-project/files?query=UntrackedOnly"))
        expect(untrackedRes.status).toBe(200)
        const untrackedBody = await untrackedRes.json() as { files: Array<{ path: string }> }
        expect(untrackedBody.files).toEqual([])
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    })

    test("lists task worktree files", async () => {
      const worktree = join(tmpdir(), `tangerine-task-files-${crypto.randomUUID()}`)
      try {
        mkdirSync(join(worktree, "packages", "server"), { recursive: true })
        writeFileSync(join(worktree, "packages", "server", "index.ts"), "export {}\n")
        Bun.spawnSync(["git", "init", worktree], { env: cleanGitEnv() })
        const row = seedTask(db)
        db.prepare("UPDATE tasks SET worktree_path = ? WHERE id = ?").run(worktree, row.id)

        const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/files?query=server`))
        expect(res.status).toBe(200)
        const body = await res.json() as { files: Array<{ path: string }> }
        expect(body.files).toEqual([{ path: "packages/server/index.ts" }])
      } finally {
        rmSync(worktree, { recursive: true, force: true })
      }
    })

    test("falls back to project repo files when task has no worktree yet", async () => {
      const workspace = join(tmpdir(), `tangerine-task-fallback-files-${crypto.randomUUID()}`)
      const repoDir = join(workspace, "test-project", "0")
      try {
        mkdirSync(join(repoDir, "src"), { recursive: true })
        writeFileSync(join(repoDir, "src", "RootFile.ts"), "export const root = true\n")
        Bun.spawnSync(["git", "init", repoDir], { env: cleanGitEnv() })
        Bun.spawnSync(["git", "-C", repoDir, "add", "."], { env: cleanGitEnv() })
        Bun.spawnSync(["git", "-C", repoDir, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], { env: cleanGitEnv() })
        deps = createMockDeps(db, { workspace })
        app = createApp(deps).app
        const row = seedTask(db)

        const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/files?query=Root`))
        expect(res.status).toBe(200)
        const body = await res.json() as { files: Array<{ path: string }> }
        expect(body.files).toEqual([{ path: "src/RootFile.ts" }])
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    })
  })

  describe("GET /api/health", () => {
    test("returns ok", async () => {
      const res = await app.fetch(new Request("http://localhost/api/health"))
      expect(res.status).toBe(200)
      const body = await res.json() as { status: string }
      expect(body.status).toBe("ok")
    })
  })

  describe("auth", () => {
    test("session route reports auth disabled by default", async () => {
      const res = await app.fetch(new Request("http://localhost/api/auth/session"))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ enabled: false, authenticated: true })
    })

    test("protects API routes when auth is enabled", async () => {
      deps.config.credentials.tangerineAuthToken = "secret-token"
      app = createApp(deps).app

      const unauthorized = await app.fetch(new Request("http://localhost/api/tasks"))
      expect(unauthorized.status).toBe(401)

      const authorized = await app.fetch(new Request("http://localhost/api/tasks", {
        headers: { Authorization: "Bearer secret-token" },
      }))
      expect(authorized.status).toBe(200)
    })

    test("session route reports authenticated state when auth is enabled", async () => {
      deps.config.credentials.tangerineAuthToken = "secret-token"
      app = createApp(deps).app

      const unauthorized = await app.fetch(new Request("http://localhost/api/auth/session"))
      expect(unauthorized.status).toBe(200)
      expect(await unauthorized.json()).toEqual({ enabled: true, authenticated: false })

      const authorized = await app.fetch(new Request("http://localhost/api/auth/session", {
        headers: { Authorization: "Bearer secret-token" },
      }))
      expect(authorized.status).toBe(200)
      expect(await authorized.json()).toEqual({ enabled: true, authenticated: true })
    })

    test("health route remains public when auth is enabled", async () => {
      deps.config.credentials.tangerineAuthToken = "secret-token"
      app = createApp(deps).app

      const res = await app.fetch(new Request("http://localhost/api/health"))
      expect(res.status).toBe(200)
    })

    test("websocket endpoints stay public for in-band auth", () => {
      expect(isPublicApiPath("/api/tasks/task-123/ws")).toBe(true)
      expect(isPublicApiPath("/api/tasks/task-123/terminal")).toBe(true)
      expect(isPublicApiPath("/api/tasks/task-123/messages")).toBe(false)
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

  describe("GET /api/tasks/counts", () => {
    test("returns counts grouped by project", async () => {
      seedTask(db, { title: "Task1", project_id: "test-project" })
      seedTask(db, { title: "Task2", project_id: "test-project" })
      seedTask(db, { title: "Task3", project_id: "other-project" })

      const res = await app.fetch(new Request("http://localhost/api/tasks/counts"))
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, number>
      expect(body["test-project"]).toBe(2)
      expect(body["other-project"]).toBe(1)
    })

    test("filters by status", async () => {
      const task1 = seedTask(db, { title: "Running", project_id: "test-project" })
      const task2 = seedTask(db, { title: "Done", project_id: "test-project" })
      Effect.runSync(updateTaskStatus(db, task1.id, "running"))
      Effect.runSync(updateTaskStatus(db, task2.id, "done"))

      const res = await app.fetch(new Request("http://localhost/api/tasks/counts?status=running"))
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, number>
      expect(body["test-project"]).toBe(1)
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

    test("suspended running task always returns agentStatus=idle (survives restart with empty in-memory state)", async () => {
      const row = seedTask(db, { title: "Idle Task" })
      db.prepare("UPDATE tasks SET status = 'running', suspended = 1 WHERE id = ?").run(row.id)

      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}`))
      expect(res.status).toBe(200)
      const body = await res.json() as { status: string; suspended: boolean; agentStatus?: string }
      expect(body.status).toBe("running")
      expect(body.suspended).toBe(true)
      expect(body.agentStatus).toBe("idle")
    })

    test("suspended running task appears as agentStatus=idle in task list", async () => {
      const row = seedTask(db, { title: "Suspended Task" })
      db.prepare("UPDATE tasks SET status = 'running', suspended = 1 WHERE id = ?").run(row.id)

      const res = await app.fetch(new Request("http://localhost/api/tasks"))
      expect(res.status).toBe(200)
      const tasks = await res.json() as Array<{ id: string; agentStatus?: string }>
      const task = tasks.find((t) => t.id === row.id)
      expect(task?.agentStatus).toBe("idle")
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

    test("passes undefined provider to createTask when not specified (lets manager use defaultProvider)", async () => {
      let capturedProvider: string | undefined = "sentinel"
      const original = deps.taskManager.createTask
      deps.taskManager.createTask = (params) => {
        capturedProvider = params.provider
        return original(params)
      }

      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", title: "New task" }),
      }))
      expect(res.status).toBe(201)
      expect(capturedProvider).toBeUndefined()
    })

    test("returns 400 for invalid provider", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", title: "New task", provider: "openai" }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("provider")
    })

    test("accepts configured ACP agent ids as providers", async () => {
      deps.config.config.agents = [{ id: "my-agent", name: "My Agent", command: "my-agent-acp" }]
      let capturedProvider: string | undefined
      const original = deps.taskManager.createTask
      deps.taskManager.createTask = (params) => {
        capturedProvider = params.provider
        return original(params)
      }

      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", title: "New task", provider: "my-agent" }),
      }))

      expect(res.status).toBe(201)
      expect(capturedProvider).toBe("my-agent")
    })

    test("rejects legacy provider ids when they are not configured ACP agents", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", title: "New task", provider: "claude-code" }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("Invalid provider")
    })

    test("passes ACP reasoningEffort through without legacy provider validation", async () => {
      let capturedReasoning: string | undefined
      const original = deps.taskManager.createTask
      deps.taskManager.createTask = (params) => {
        capturedReasoning = params.reasoningEffort
        return original(params)
      }

      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", title: "Task", provider: "acp", reasoningEffort: "agent-specific" }),
      }))
      expect(res.status).toBe(201)
      expect(capturedReasoning).toBe("agent-specific")
    })

    test("accepts prUrl for worker tasks", async () => {
      let capturedPrUrl: string | undefined
      const original = deps.taskManager.createTask
      deps.taskManager.createTask = (params) => { capturedPrUrl = params.prUrl; return original(params) }

      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", title: "Task", type: "worker", prUrl: "https://github.com/test/repo/pull/42" }),
      }))
      expect(res.status).toBe(201)
      expect(capturedPrUrl).toBe("https://github.com/test/repo/pull/42")
    })

    test("accepts prUrl for reviewer tasks", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", title: "Task", type: "reviewer", prUrl: "https://github.com/test/repo/pull/42" }),
      }))
      expect(res.status).toBe(201)
    })

    test("rejects prUrl for orchestrator tasks", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", title: "Task", type: "orchestrator", prUrl: "https://github.com/test/repo/pull/42" }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("pr-track")
    })

    test("rejects prUrl for runner tasks", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", title: "Task", type: "runner", prUrl: "https://github.com/test/repo/pull/42" }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("pr-track")
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
      const body = await res.json() as { title: string; status: string }
      expect(body.title).toBe("Fix bug found in other project")
      expect(body.status).toBe("created")
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
      const body = await res.json() as { id: string; title: string; status: string }
      expect(body.id).toBeTruthy()
      expect(body.status).toBe("created")
    })
  })

  describe("PATCH /api/tasks/:id", () => {
    test("updates prUrl", async () => {
      const row = seedTask(db)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl: "https://github.com/test/repo/pull/42" }),
      }))
      expect(res.status).toBe(200)
      const body = await res.json() as { id: string; title: string; status: string }
      expect(body.id).toBe(row.id)
    })

    test("clears prUrl when set to null", async () => {
      const row = seedTask(db)
      db.prepare("UPDATE tasks SET pr_url = 'https://github.com/test/repo/pull/1' WHERE id = ?").run(row.id)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl: null }),
      }))
      expect(res.status).toBe(200)
      const body = await res.json() as { id: string }
      expect(body.id).toBe(row.id)
    })

    test("returns 404 for unknown task", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks/nonexistent", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl: "https://github.com/test/repo/pull/1" }),
      }))
      expect(res.status).toBe(404)
    })

    test("rejects prUrl for orchestrator tasks", async () => {
      const row = seedTask(db, { type: "orchestrator" })
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl: "https://github.com/test/repo/pull/99" }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("pr")
    })
  })

  describe("POST /api/tasks/:id/rename-branch", () => {
    test("returns 400 when branch is missing", async () => {
      const row = seedTask(db)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/rename-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("branch is required")
    })

    test("returns 400 when branch contains whitespace", async () => {
      const row = seedTask(db)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/rename-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "bad branch name" }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("Invalid branch name")
    })

    test("returns 400 when branch contains shell metacharacters", async () => {
      const row = seedTask(db)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/rename-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "feature; touch /tmp/pwned" }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("Invalid branch name")
    })

    test("returns 404 for unknown task", async () => {
      const res = await app.fetch(new Request("http://localhost/api/tasks/nonexistent/rename-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "new-name" }),
      }))
      expect(res.status).toBe(404)
    })

    test("rejects rename for reviewer tasks", async () => {
      const row = seedTask(db, { type: "reviewer" })
      db.prepare("UPDATE tasks SET worktree_path = '/tmp/test', branch = 'tangerine/old' WHERE id = ?").run(row.id)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/rename-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "tangerine/new-name" }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("pr-create")
    })

    test("returns 400 when task has no worktree", async () => {
      const row = seedTask(db)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/rename-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "new-name" }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("no worktree")
    })

    test("rejects rename for tasks with non-tangerine branch", async () => {
      const row = seedTask(db)
      db.prepare("UPDATE tasks SET worktree_path = '/tmp/test', branch = 'feature/existing' WHERE id = ?").run(row.id)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/rename-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "tangerine/new-name" }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("not managed by Tangerine")
    })

    test("returns 400 when task has no branch", async () => {
      const row = seedTask(db)
      db.prepare("UPDATE tasks SET worktree_path = '/tmp/test' WHERE id = ?").run(row.id)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/rename-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "new-name" }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("no branch")
    })

    test("renames branch and updates task.branch in DB", async () => {
      // Set up a real git repo so git branch -m succeeds.
      const repoDir = `/tmp/tangerine-test-rename-${crypto.randomUUID()}`
      Bun.spawnSync(["git", "init", repoDir], { env: cleanGitEnv() })
      Bun.spawnSync(["git", "-C", repoDir, "config", "user.email", "test@test.com"], { env: cleanGitEnv() })
      Bun.spawnSync(["git", "-C", repoDir, "config", "user.name", "Test"], { env: cleanGitEnv() })
      Bun.spawnSync(["git", "-C", repoDir, "commit", "--allow-empty", "-m", "init"], { env: cleanGitEnv() })
      Bun.spawnSync(["git", "-C", repoDir, "checkout", "-b", "tangerine/old-branch"], { env: cleanGitEnv() })

      const row = seedTask(db)
      db.prepare("UPDATE tasks SET worktree_path = ?, branch = 'tangerine/old-branch' WHERE id = ?").run(repoDir, row.id)

      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/rename-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "fix/my-descriptive-name" }),
      }))
      expect(res.status).toBe(200)
      const body = await res.json() as { id: string; status: string }
      expect(body.id).toBe(row.id)

      // Verify DB was updated
      const updated = Effect.runSync(dbGetTask(db, row.id))
      expect(updated?.branch).toBe("fix/my-descriptive-name")
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

  describe("GET /api/tasks/:id/config-options", () => {
    test("returns active ACP session config options", async () => {
      const row = seedTask(db)
      ;(getTaskState(row.id) as { configOptions?: unknown[] }).configOptions = [{
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5",
        options: [{ value: "gpt-5", name: "GPT-5" }],
      }]

      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/config-options`))

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ configOptions: [{
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5",
        options: [{ value: "gpt-5", name: "GPT-5" }],
      }] })
    })
  })

  describe("GET /api/tasks/:id/slash-commands", () => {
    test("returns active ACP slash commands", async () => {
      const row = seedTask(db)
      ;(getTaskState(row.id) as { slashCommands?: unknown[] }).slashCommands = [
        { name: "compact", description: "Compact conversation", input: { hint: "instructions" } },
      ]

      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/slash-commands`))

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ commands: [
        { name: "compact", description: "Compact conversation", input: { hint: "instructions" } },
      ] })
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

    test("includes in-flight ACP assistant stream after persisted logs", async () => {
      const row = seedTask(db)
      Effect.runSync(insertSessionLog(db, { task_id: row.id, role: "user", content: "Build it" }))
      ;(getTaskState(row.id) as ReturnType<typeof getTaskState> & {
        activeAssistantMessage?: { role: "assistant"; content: string; messageId: string; timestamp: string }
      }).activeAssistantMessage = {
        role: "assistant",
        content: "Working on it...",
        messageId: "stream-1",
        timestamp: "2026-04-28T10:00:00.000Z",
      }

      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/messages`))

      expect(res.status).toBe(200)
      const body = await res.json() as Array<{ id: number | string; role: string; content: string; transient?: boolean }>
      expect(body).toHaveLength(2)
      expect(body[0]).toMatchObject({ role: "user", content: "Build it" })
      expect(body[1]).toMatchObject({
        id: "assistant-stream-1",
        role: "assistant",
        content: "Working on it...",
        transient: true,
      })
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

  describe("queued prompts", () => {
    test("returns, edits, and removes queued prompts", async () => {
      const row = seedTask(db)
      const queued = Effect.runSync(enqueue(row.id, "Original"))

      const listRes = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/queue`))
      expect(listRes.status).toBe(200)
      const listed = await listRes.json() as { queuedPrompts: Array<{ id: string; text: string; enqueuedAt: number }> }
      expect(listed.queuedPrompts).toEqual([{ id: queued.id, text: "Original", enqueuedAt: queued.enqueuedAt }])

      const editRes = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/queue/${queued.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Edited" }),
      }))
      expect(editRes.status).toBe(200)
      const edited = await editRes.json() as { queuedPrompt: { text: string } }
      expect(edited.queuedPrompt.text).toBe("Edited")

      const deleteRes = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/queue/${queued.id}`, { method: "DELETE" }))
      expect(deleteRes.status).toBe(204)

      const emptyRes = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/queue`))
      const empty = await emptyRes.json() as { queuedPrompts: unknown[] }
      expect(empty.queuedPrompts).toEqual([])

      Effect.runSync(clearQueue(row.id))
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

    test("changes ACP mode for a task", async () => {
      const row = seedTask(db)
      db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(row.id)
      let received: { mode?: string } | undefined
      deps.taskManager.changeConfig = (_taskId, config) => Effect.sync(() => { received = config })
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "code" }),
      }))
      expect(res.status).toBe(200)
      expect(received).toEqual({ mode: "code" })
    })

    test("returns 400 without model, reasoningEffort, or mode", async () => {
      const row = seedTask(db)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }))
      expect(res.status).toBe(400)
    })

    test("passes ACP reasoningEffort changes through without legacy provider validation", async () => {
      const row = seedTask(db, { provider: "acp" })
      db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(row.id)
      const res = await app.fetch(new Request(`http://localhost/api/tasks/${row.id}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasoningEffort: "agent-specific" }),
      }))
      expect(res.status).toBe(200)
      const updated = db.prepare("SELECT reasoning_effort FROM tasks WHERE id = ?").get(row.id) as { reasoning_effort: string }
      expect(updated.reasoning_effort).toBe("agent-specific")
    })
  })

  describe("POST /api/crons", () => {
    test("accepts configured ACP agent ids in task defaults", async () => {
      deps.config.config.agents = [{ id: "nightly-agent", name: "Nightly Agent", command: "nightly-acp" }]

      const res = await app.fetch(new Request("http://localhost/api/crons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "test-project",
          title: "Nightly",
          cron: "0 9 * * 1",
          taskDefaults: { provider: "nightly-agent" },
        }),
      }))

      expect(res.status).toBe(201)
      const body = await res.json() as { taskDefaults: { provider?: string } | null }
      expect(body.taskDefaults?.provider).toBe("nightly-agent")
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

  describe("GET /api/projects", () => {
    test("does not expose legacy provider metadata or model discovery", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects"))
      expect(res.status).toBe(200)
      const body = await res.json() as { modelsByProvider?: unknown; providerMetadata?: unknown; contextWindowByModel?: unknown }
      expect(body.modelsByProvider).toBeUndefined()
      expect(body.providerMetadata).toBeUndefined()
      expect(body.contextWindowByModel).toBeUndefined()
    })

    test("returns configured ACP agents", async () => {
      deps.config.config.defaultAgent = "my-agent"
      deps.config.config.agents = [{ id: "my-agent", name: "My Agent", command: "my-agent-acp" }]
      const res = await app.fetch(new Request("http://localhost/api/projects"))
      expect(res.status).toBe(200)
      const body = await res.json() as { agents?: unknown[]; defaultAgent?: string }
      expect(body.defaultAgent).toBe("my-agent")
      expect(body.agents).toEqual([{ id: "my-agent", name: "My Agent", command: "my-agent-acp" }])
    })

    test("includes systemCapabilities in response", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects"))
      expect(res.status).toBe(200)
      const body = await res.json() as { systemCapabilities: import("@tangerine/shared").SystemCapabilities }
      expect(body.systemCapabilities).toBeDefined()
      expect(body.systemCapabilities.git).toEqual({ available: true })
      expect(body.systemCapabilities.gh).toEqual({ available: true, authenticated: true })
      expect(body.systemCapabilities.providers.acp).toEqual({ available: true, cliCommand: "acp-agent" })
    })

    test("reflects unavailable providers in systemCapabilities", async () => {
      deps.systemCapabilities = {
        ...deps.systemCapabilities,
        providers: {
          ...deps.systemCapabilities.providers,
          "custom-agent": { available: false, cliCommand: "custom-acp" },
        },
      }
      app = createApp(deps).app

      const res = await app.fetch(new Request("http://localhost/api/projects"))
      const body = await res.json() as { systemCapabilities: import("@tangerine/shared").SystemCapabilities }
      expect(body.systemCapabilities.providers["custom-agent"]).toEqual({ available: false, cliCommand: "custom-acp" })
      expect(body.systemCapabilities.providers.acp?.available).toBe(true)
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

  describe("POST /api/projects/:name/archive", () => {
    test("archives a project", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects/test-project/archive", { method: "POST" }))
      expect(res.status).toBe(200)
      expect(deps.config.config.projects[0]!.archived).toBe(true)
    })

    test("is idempotent when already archived", async () => {
      await app.fetch(new Request("http://localhost/api/projects/test-project/archive", { method: "POST" }))
      const res = await app.fetch(new Request("http://localhost/api/projects/test-project/archive", { method: "POST" }))
      expect(res.status).toBe(200)
    })

    test("returns 404 for unknown project", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects/nonexistent/archive", { method: "POST" }))
      expect(res.status).toBe(404)
    })

    test("cancels running tasks on archive", async () => {
      const row = seedTask(db, { title: "Running task" })
      db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(row.id)

      await app.fetch(new Request("http://localhost/api/projects/test-project/archive", { method: "POST" }))

      const updated = db.prepare("SELECT status FROM tasks WHERE id = ?").get(row.id) as { status: string }
      expect(updated.status).toBe("cancelled")
    })
  })

  describe("POST /api/projects/:name/unarchive", () => {
    test("unarchives a project", async () => {
      await app.fetch(new Request("http://localhost/api/projects/test-project/archive", { method: "POST" }))
      expect(deps.config.config.projects[0]!.archived).toBe(true)

      const res = await app.fetch(new Request("http://localhost/api/projects/test-project/unarchive", { method: "POST" }))
      expect(res.status).toBe(200)
      expect(deps.config.config.projects[0]!.archived).toBe(false)
    })

    test("is idempotent when not archived", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects/test-project/unarchive", { method: "POST" }))
      expect(res.status).toBe(200)
    })

    test("returns 404 for unknown project", async () => {
      const res = await app.fetch(new Request("http://localhost/api/projects/nonexistent/unarchive", { method: "POST" }))
      expect(res.status).toBe(404)
    })
  })

  describe("POST /api/tasks (archived project)", () => {
    test("returns 400 when creating task for archived project", async () => {
      await app.fetch(new Request("http://localhost/api/projects/test-project/archive", { method: "POST" }))

      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", title: "New task" }),
      }))
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain("archived")
    })

    test("allows task creation after unarchive", async () => {
      await app.fetch(new Request("http://localhost/api/projects/test-project/archive", { method: "POST" }))
      await app.fetch(new Request("http://localhost/api/projects/test-project/unarchive", { method: "POST" }))

      const res = await app.fetch(new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "test-project", title: "New task after unarchive" }),
      }))
      expect(res.status).toBe(201)
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
