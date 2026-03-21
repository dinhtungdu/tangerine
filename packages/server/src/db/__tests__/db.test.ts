import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Exit, Cause, Option } from "effect"
import { SCHEMA } from "../schema"
import { getDb, resetDb, autoMigrate } from "../index"
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  updateTaskStatus,
  createVm,
  getVm,
  listVms,
  updateVm,
  updateVmStatus,
  insertSessionLog,
  getSessionLogs,
  createImage,
  getImage,
  listImages,
  pruneOldImages,
} from "../queries"

function freshDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA)
  return db
}

describe("tasks", () => {
  let db: Database

  beforeEach(() => {
    db = freshDb()
  })

  test("create and retrieve a task", () => {
    const task = Effect.runSync(createTask(db, {
      id: "task-1",
      source: "manual",
      project_id: "test",
      repo_url: "https://github.com/test/repo",
      title: "Test task",
    }))

    expect(task.id).toBe("task-1")
    expect(task.source).toBe("manual")
    expect(task.status).toBe("created")
    expect(task.title).toBe("Test task")

    const retrieved = Effect.runSync(getTask(db, "task-1"))
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe("task-1")
  })

  test("returns null for non-existent task", () => {
    const exit = Effect.runSyncExit(getTask(db, "nonexistent"))
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBeNull()
    } else {
      // If getTask uses a TaskNotFoundError for missing tasks, verify the failure
      const error = Cause.failureOption(exit.cause)
      expect(Option.isSome(error)).toBe(true)
    }
  })

  test("update task status", () => {
    Effect.runSync(createTask(db, {
      id: "task-2",
      source: "github",
      project_id: "test",
      repo_url: "https://github.com/test/repo",
      title: "Status test",
    }))

    const updated = Effect.runSync(updateTaskStatus(db, "task-2", "running"))
    expect(updated).not.toBeNull()
    expect(updated!.status).toBe("running")
  })

  test("update task fields", () => {
    Effect.runSync(createTask(db, {
      id: "task-3",
      source: "manual",
      project_id: "test",
      repo_url: "https://github.com/test/repo",
      title: "Update test",
    }))

    const updated = Effect.runSync(updateTask(db, "task-3", {
      branch: "feat/test",
      vm_id: "vm-1",
      error: null,
    }))
    expect(updated).not.toBeNull()
    expect(updated!.branch).toBe("feat/test")
    expect(updated!.vm_id).toBe("vm-1")
  })

  test("list tasks by status filter", () => {
    Effect.runSync(createTask(db, { id: "t-a", source: "manual", project_id: "test", repo_url: "r", title: "A" }))
    Effect.runSync(createTask(db, { id: "t-b", source: "manual", project_id: "test", repo_url: "r", title: "B" }))
    Effect.runSync(updateTaskStatus(db, "t-b", "running"))

    const all = Effect.runSync(listTasks(db))
    expect(all.length).toBe(2)

    const created = Effect.runSync(listTasks(db, { status: "created" }))
    expect(created.length).toBe(1)
    expect(created[0]!.id).toBe("t-a")

    const running = Effect.runSync(listTasks(db, { status: "running" }))
    expect(running.length).toBe(1)
    expect(running[0]!.id).toBe("t-b")
  })
})

describe("vms", () => {
  let db: Database

  beforeEach(() => {
    db = freshDb()
  })

  test("create and retrieve a VM", () => {
    const vm = Effect.runSync(createVm(db, {
      id: "vm-1",
      label: "test-vm",
      provider: "lima",
      project_id: "test",
      snapshot_id: "snap-1",
      region: "local",
      plan: "default",
    }))

    expect(vm.id).toBe("vm-1")
    expect(vm.status).toBe("provisioning")
    expect(vm.provider).toBe("lima")
    expect(vm.project_id).toBe("test")

    const retrieved = Effect.runSync(getVm(db, "vm-1"))
    expect(retrieved).not.toBeNull()
    expect(retrieved!.label).toBe("test-vm")
  })

  test("update VM status", () => {
    Effect.runSync(createVm(db, {
      id: "vm-2",
      label: "vm-two",
      provider: "lima",
      project_id: "test",
      snapshot_id: "snap-1",
      region: "local",
      plan: "default",
    }))

    const updated = Effect.runSync(updateVmStatus(db, "vm-2", "active"))
    expect(updated!.status).toBe("active")
  })

  test("update VM fields", () => {
    Effect.runSync(createVm(db, {
      id: "vm-3",
      label: "vm-three",
      provider: "lima",
      project_id: "test",
      snapshot_id: "snap-1",
      region: "local",
      plan: "default",
      status: "active",
    }))

    const stopped = Effect.runSync(updateVm(db, "vm-3", { status: "stopped" }))
    expect(stopped!.status).toBe("stopped")
    expect(stopped!.project_id).toBe("test")
  })

  test("list VMs by status", () => {
    Effect.runSync(createVm(db, { id: "v-a", label: "a", provider: "lima", project_id: "test", snapshot_id: "s", region: "local", plan: "default" }))
    Effect.runSync(createVm(db, { id: "v-b", label: "b", provider: "lima", project_id: "test", snapshot_id: "s", region: "local", plan: "default" }))
    Effect.runSync(updateVmStatus(db, "v-b", "active"))

    const all = Effect.runSync(listVms(db))
    expect(all.length).toBe(2)

    const active = Effect.runSync(listVms(db, "active"))
    expect(active.length).toBe(1)
    expect(active[0]!.id).toBe("v-b")
  })
})

describe("session logs", () => {
  let db: Database

  beforeEach(() => {
    db = freshDb()
  })

  test("insert and retrieve session logs", () => {
    Effect.runSync(createTask(db, { id: "task-log", source: "manual", project_id: "test", repo_url: "r", title: "Log test" }))

    Effect.runSync(insertSessionLog(db, { task_id: "task-log", role: "user", content: "Hello" }))
    Effect.runSync(insertSessionLog(db, { task_id: "task-log", role: "assistant", content: "Hi there" }))

    const logs = Effect.runSync(getSessionLogs(db, "task-log"))
    expect(logs.length).toBe(2)
    expect(logs[0]!.role).toBe("user")
    expect(logs[0]!.content).toBe("Hello")
    expect(logs[1]!.role).toBe("assistant")
    expect(logs[1]!.content).toBe("Hi there")
  })

  test("returns empty array for task with no logs", () => {
    Effect.runSync(createTask(db, { id: "task-empty", source: "manual", project_id: "test", repo_url: "r", title: "Empty" }))
    const logs = Effect.runSync(getSessionLogs(db, "task-empty"))
    expect(logs.length).toBe(0)
  })
})

describe("images", () => {
  let db: Database

  beforeEach(() => {
    db = freshDb()
  })

  test("create and retrieve images", () => {
    const image = Effect.runSync(createImage(db, {
      id: "img-1",
      name: "base-debian",
      provider: "lima",
      snapshot_id: "snap-abc",
    }))

    expect(image.id).toBe("img-1")
    expect(image.name).toBe("base-debian")

    const retrieved = Effect.runSync(getImage(db, "img-1"))
    expect(retrieved).not.toBeNull()
    expect(retrieved!.snapshot_id).toBe("snap-abc")
  })

  test("list images", () => {
    Effect.runSync(createImage(db, { id: "i-1", name: "a", provider: "lima", snapshot_id: "s1" }))
    Effect.runSync(createImage(db, { id: "i-2", name: "b", provider: "lima", snapshot_id: "s2" }))

    const images = Effect.runSync(listImages(db))
    expect(images.length).toBe(2)
  })

  test("prunes outdated images for the same name", () => {
    Effect.runSync(createImage(db, { id: "i-1", name: "woo", provider: "lima", snapshot_id: "s1" }))
    Effect.runSync(createImage(db, { id: "i-2", name: "woo", provider: "lima", snapshot_id: "s2" }))
    Effect.runSync(createImage(db, { id: "i-3", name: "other", provider: "lima", snapshot_id: "s3" }))

    const pruned = Effect.runSync(pruneOldImages(db, "woo", "i-2"))

    expect(pruned).toBe(1)
    const images = Effect.runSync(listImages(db))
    expect(images.map((image) => image.id).sort()).toEqual(["i-2", "i-3"])
  })
})

describe("auto-migration", () => {
  beforeEach(() => {
    resetDb()
  })

  test("adds missing columns to existing tables", () => {
    // Create a DB with an older schema missing some columns
    const db = new Database(":memory:")
    db.run("PRAGMA foreign_keys = ON")
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        provider TEXT NOT NULL DEFAULT 'opencode',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS vms (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'provisioning',
        project_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        region TEXT NOT NULL,
        plan TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS session_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        event TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        logger TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)

    // Verify columns are missing before migration
    const colsBefore = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name)
    expect(colsBefore).not.toContain("model")
    expect(colsBefore).not.toContain("reasoning_effort")
    expect(colsBefore).not.toContain("description")
    expect(colsBefore).not.toContain("vm_id")

    // Run autoMigrate (adds missing columns), then full schema (creates indexes)
    autoMigrate(db)
    db.exec(SCHEMA)

    // Verify columns were added
    const colsAfter = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name)
    expect(colsAfter).toContain("model")
    expect(colsAfter).toContain("reasoning_effort")
    expect(colsAfter).toContain("description")
    expect(colsAfter).toContain("vm_id")
    expect(colsAfter).toContain("branch")
    expect(colsAfter).toContain("worktree_path")
    expect(colsAfter).toContain("agent_session_id")

    // Verify we can insert with the new columns
    db.prepare("INSERT INTO tasks (id, project_id, source, repo_url, title, model, reasoning_effort) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("test-1", "proj", "manual", "repo", "title", "claude-opus-4-6", "high")
    const row = db.prepare("SELECT model, reasoning_effort FROM tasks WHERE id = ?").get("test-1") as { model: string; reasoning_effort: string }
    expect(row.model).toBe("claude-opus-4-6")
    expect(row.reasoning_effort).toBe("high")

    db.close()
  })

  test("is idempotent — running twice doesn't error", () => {
    const db = new Database(":memory:")
    db.run("PRAGMA foreign_keys = ON")
    db.exec(SCHEMA)
    // Run schema again — CREATE IF NOT EXISTS + autoMigrate should be no-ops
    db.exec(SCHEMA)
    // All columns already exist — no errors
    const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain("model")
    expect(cols).toContain("reasoning_effort")
    db.close()
  })
})
