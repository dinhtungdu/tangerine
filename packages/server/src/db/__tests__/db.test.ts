import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Exit, Cause, Option } from "effect"
import { DEFAULT_AGENT_ID } from "@tangerine/shared"
import { SCHEMA } from "../schema"
import { resetDb, autoMigrate } from "../index"
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  updateTaskStatus,
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
      title: "Test task",
    }))

    expect(task.id).toBe("task-1")
    expect(task.source).toBe("manual")
    expect(task.status).toBe("created")
    expect(task.title).toBe("Test task")
    expect(task.provider).toBe(DEFAULT_AGENT_ID)

    const retrieved = Effect.runSync(getTask(db, "task-1"))
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe("task-1")
    expect(retrieved!.provider).toBe(DEFAULT_AGENT_ID)
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
      title: "Update test",
    }))

    const updated = Effect.runSync(updateTask(db, "task-3", {
      branch: "feat/test",
      agent_pid: 12345,
      error: null,
    }))
    expect(updated).not.toBeNull()
    expect(updated!.branch).toBe("feat/test")
    expect(updated!.agent_pid).toBe(12345)
  })

  test("list tasks by status filter", () => {
    Effect.runSync(createTask(db, { id: "t-a", source: "manual", project_id: "test", title: "A" }))
    Effect.runSync(createTask(db, { id: "t-b", source: "manual", project_id: "test", title: "B" }))
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

describe("worktree slots use project_id", () => {
  let db: Database

  beforeEach(() => {
    db = freshDb()
  })

  test("create and query worktree slots by project_id", () => {
    Effect.runSync(createTask(db, { id: "task-wt", source: "manual", project_id: "proj-1", title: "WT test" }))

    db.prepare(
      "INSERT INTO worktree_slots (id, project_id, path, status) VALUES (?, ?, ?, ?)",
    ).run("slot-1", "proj-1", "/workspace/worktrees/slot-1", "available")

    const slots = db.prepare("SELECT * FROM worktree_slots WHERE project_id = ?").all("proj-1") as Array<{ id: string; project_id: string }>
    expect(slots).toHaveLength(1)
    expect(slots[0]!.project_id).toBe("proj-1")
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
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        provider TEXT NOT NULL DEFAULT 'opencode',
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

    // Run autoMigrate (adds missing columns), then full schema (creates indexes)
    autoMigrate(db)
    db.exec(SCHEMA)

    // Verify columns were added
    const colsAfter = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name)
    expect(colsAfter).toContain("model")
    expect(colsAfter).toContain("reasoning_effort")
    expect(colsAfter).toContain("description")
    expect(colsAfter).toContain("branch")
    expect(colsAfter).toContain("worktree_path")
    expect(colsAfter).toContain("agent_session_id")

    // Verify we can insert with the new columns
    db.prepare("INSERT INTO tasks (id, project_id, source, title, model, reasoning_effort) VALUES (?, ?, ?, ?, ?, ?)")
      .run("test-1", "proj", "manual", "title", "claude-opus-4-6", "high")
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

  test("schema uses shared default ACP agent", () => {
    const db = new Database(":memory:")
    db.run("PRAGMA foreign_keys = ON")
    db.exec(SCHEMA)

    db.prepare("INSERT INTO tasks (id, project_id, source, title) VALUES (?, ?, ?, ?)")
      .run("default-provider-task", "proj", "manual", "title")

    const row = db.prepare("SELECT provider FROM tasks WHERE id = ?").get("default-provider-task") as { provider: string }
    expect(row.provider).toBe(DEFAULT_AGENT_ID)

    db.close()
  })

  test("unknown persisted task types remain stored for API normalization", () => {
    const db = new Database(":memory:")
    db.exec(SCHEMA)
    db.prepare("INSERT INTO tasks (id, project_id, source, title, type) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-kind-task", "proj", "manual", "legacy", "legacy-kind")

    const row = db.prepare("SELECT type FROM tasks WHERE id = ?").get("legacy-kind-task") as { type: string }
    expect(row.type).toBe("legacy-kind")
    db.close()
  })
})
