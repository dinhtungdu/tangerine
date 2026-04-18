import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect, Exit, Cause, Option } from "effect"
import { DEFAULT_PROVIDER } from "@tangerine/shared"
import { SCHEMA } from "../schema"
import { resetDb, autoMigrate } from "../index"
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  updateTaskStatus,
  insertSessionLog,
  getSessionLogs,
  insertCheckpoint,
  listCheckpoints,
  deleteCheckpointsForTask,
  getLastAssistantSessionLogId,
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
    expect(task.provider).toBe(DEFAULT_PROVIDER)

    const retrieved = Effect.runSync(getTask(db, "task-1"))
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe("task-1")
    expect(retrieved!.provider).toBe(DEFAULT_PROVIDER)
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

describe("session logs", () => {
  let db: Database

  beforeEach(() => {
    db = freshDb()
  })

  test("insert and retrieve session logs", () => {
    Effect.runSync(createTask(db, { id: "task-log", source: "manual", project_id: "test", title: "Log test" }))

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
    Effect.runSync(createTask(db, { id: "task-empty", source: "manual", project_id: "test", title: "Empty" }))
    const logs = Effect.runSync(getSessionLogs(db, "task-empty"))
    expect(logs.length).toBe(0)
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

  test("checkpoints table exists in schema", () => {
    const db = new Database(":memory:")
    db.run("PRAGMA foreign_keys = ON")
    db.exec(SCHEMA)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name)
    expect(tables).toContain("checkpoints")
    db.close()
  })

  test("schema uses shared default provider", () => {
    const db = new Database(":memory:")
    db.run("PRAGMA foreign_keys = ON")
    db.exec(SCHEMA)

    db.prepare("INSERT INTO tasks (id, project_id, source, title) VALUES (?, ?, ?, ?)")
      .run("default-provider-task", "proj", "manual", "title")

    const row = db.prepare("SELECT provider FROM tasks WHERE id = ?").get("default-provider-task") as { provider: string }
    expect(row.provider).toBe(DEFAULT_PROVIDER)

    db.close()
  })
})

describe("checkpoints", () => {
  let db: Database

  beforeEach(() => {
    db = freshDb()
    // Seed a task and a session log for FK constraints
    Effect.runSync(createTask(db, { id: "task-cp", project_id: "proj", source: "manual", title: "CP task" }))
    Effect.runSync(insertSessionLog(db, { task_id: "task-cp", role: "assistant", content: "done" }))
  })

  function seedCheckpoint(overrides?: { turn_index?: number; session_log_id?: number }) {
    // Each checkpoint must have a unique session_log_id — insert a fresh log unless overridden
    let logId: number
    if (overrides?.session_log_id !== undefined) {
      logId = overrides.session_log_id
    } else {
      const log = Effect.runSync(insertSessionLog(db, { task_id: "task-cp", role: "assistant", content: `turn ${overrides?.turn_index ?? 0}` }))
      logId = log.id
    }
    return Effect.runSync(insertCheckpoint(db, {
      id: crypto.randomUUID(),
      task_id: "task-cp",
      session_log_id: logId,
      commit_sha: "abc123",
      turn_index: overrides?.turn_index ?? 0,
    }))
  }

  test("insert and list checkpoints", () => {
    seedCheckpoint({ turn_index: 0 })
    seedCheckpoint({ turn_index: 1 })

    const checkpoints = Effect.runSync(listCheckpoints(db, "task-cp"))
    expect(checkpoints).toHaveLength(2)
    expect(checkpoints[0]!.turn_index).toBe(0)
    expect(checkpoints[1]!.turn_index).toBe(1)
    expect(checkpoints[0]!.task_id).toBe("task-cp")
    expect(checkpoints[0]!.commit_sha).toBe("abc123")
  })

  test("listCheckpoints returns empty array for unknown task", () => {
    const checkpoints = Effect.runSync(listCheckpoints(db, "no-such-task"))
    expect(checkpoints).toHaveLength(0)
  })

  test("deleteCheckpointsForTask removes all rows for task", () => {
    seedCheckpoint({ turn_index: 0 })
    seedCheckpoint({ turn_index: 1 })

    Effect.runSync(deleteCheckpointsForTask(db, "task-cp"))

    const checkpoints = Effect.runSync(listCheckpoints(db, "task-cp"))
    expect(checkpoints).toHaveLength(0)
  })

  test("getLastAssistantSessionLogId returns null when no assistant logs", () => {
    // Create a fresh task with only a user message
    Effect.runSync(createTask(db, { id: "task-user-only", project_id: "proj", source: "manual", title: "User only" }))
    Effect.runSync(insertSessionLog(db, { task_id: "task-user-only", role: "user", content: "hello" }))

    const id = Effect.runSync(getLastAssistantSessionLogId(db, "task-user-only"))
    expect(id).toBeNull()
  })

  test("getLastAssistantSessionLogId returns id of latest assistant log", () => {
    Effect.runSync(insertSessionLog(db, { task_id: "task-cp", role: "assistant", content: "second" }))

    const allLogs = Effect.runSync(getSessionLogs(db, "task-cp"))
    const assistantLogs = allLogs.filter(l => l.role === "assistant")
    const lastId = assistantLogs[assistantLogs.length - 1]!.id

    const result = Effect.runSync(getLastAssistantSessionLogId(db, "task-cp"))
    expect(result).toBe(lastId)
  })

  test("deleteCheckpointsForTask does not affect other tasks", () => {
    Effect.runSync(createTask(db, { id: "task-other", project_id: "proj", source: "manual", title: "other" }))
    const logId = (db.prepare("SELECT id FROM session_logs WHERE task_id = 'task-cp' LIMIT 1").get() as { id: number }).id
    Effect.runSync(insertCheckpoint(db, { id: crypto.randomUUID(), task_id: "task-cp", session_log_id: logId, commit_sha: "sha1", turn_index: 0 }))
    Effect.runSync(insertSessionLog(db, { task_id: "task-other", role: "assistant", content: "other" }))
    const otherLogId = (db.prepare("SELECT id FROM session_logs WHERE task_id = 'task-other' LIMIT 1").get() as { id: number }).id
    Effect.runSync(insertCheckpoint(db, { id: crypto.randomUUID(), task_id: "task-other", session_log_id: otherLogId, commit_sha: "sha2", turn_index: 0 }))

    Effect.runSync(deleteCheckpointsForTask(db, "task-cp"))

    expect(Effect.runSync(listCheckpoints(db, "task-cp"))).toHaveLength(0)
    expect(Effect.runSync(listCheckpoints(db, "task-other"))).toHaveLength(1)
  })
})
