import { describe, it, expect } from "bun:test"
import { utc, mapTaskRow } from "../api/helpers"
import { createTestDb } from "./helpers"
import { updateTask, markTaskSeen, markTaskResult } from "../db/queries"
import { Effect } from "effect"
import type { TaskRow } from "../db/types"

describe("utc", () => {
  it("normalizes bare SQLite timestamps", () => {
    expect(utc("2026-03-27 09:13:51")).toBe("2026-03-27T09:13:51Z")
  })

  it("passes through ISO strings with Z suffix", () => {
    expect(utc("2026-03-27T09:13:51.998Z")).toBe("2026-03-27T09:13:51.998Z")
  })

  it("passes through timestamps with positive offset", () => {
    expect(utc("2026-03-27T09:13:51+05:30")).toBe("2026-03-27T09:13:51+05:30")
  })

  it("passes through timestamps with negative offset", () => {
    expect(utc("2026-03-27T09:13:51-04:00")).toBe("2026-03-27T09:13:51-04:00")
  })

  it("does not match date hyphens as timezone indicators", () => {
    // Regression: the old regex [Z+-]\d matched -0 in 2026-03-27
    const result = utc("2026-03-27 14:30:00")
    expect(result).toBe("2026-03-27T14:30:00Z")
  })

  it("returns null for null input", () => {
    expect(utc(null)).toBeNull()
  })
})

describe("mapTaskRow", () => {
  it("normalizes all timestamp fields to UTC", () => {
    const row: TaskRow = {
      id: "test-id",
      project_id: "test",
      repo_url: "https://github.com/test/test",
      source: "manual",
      source_id: null,
      source_url: null,
      title: "Test",
      description: null,
      status: "running",
      provider: "claude-code",
      model: null,
      reasoning_effort: null,
      branch: null,
      worktree_path: null,
      pr_url: null,
      parent_task_id: null,
      user_id: null,
      agent_session_id: null,
      agent_pid: null,
      error: null,
      created_at: "2026-03-27 09:00:00",
      updated_at: "2026-03-27 09:10:00",
      started_at: "2026-03-27 09:01:00",
      completed_at: null,
      last_seen_at: null,
      last_result_at: null,
      capabilities: null,
    }
    const task = mapTaskRow(row)
    expect(task.createdAt).toBe("2026-03-27T09:00:00Z")
    expect(task.updatedAt).toBe("2026-03-27T09:10:00Z")
    expect(task.startedAt).toBe("2026-03-27T09:01:00Z")
    expect(task.completedAt).toBeNull()
    expect(task.lastSeenAt).toBeNull()
    expect(task.lastResultAt).toBeNull()
  })
})

describe("updateTask skipUpdatedAt", () => {
  it("bumps updated_at by default", () => {
    const db = createTestDb()
    const id = crypto.randomUUID()
    db.prepare(
      "INSERT INTO tasks (id, project_id, repo_url, source, title, status, provider, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?, ?, datetime('now', '-1 hour'), datetime('now', '-1 hour'))",
    ).run(id, "test", "manual", "Test", "running", "claude-code")

    const before = db.prepare("SELECT updated_at FROM tasks WHERE id = ?").get(id) as { updated_at: string }
    Effect.runSync(updateTask(db, id, { title: "Updated" }))
    const after = db.prepare("SELECT updated_at FROM tasks WHERE id = ?").get(id) as { updated_at: string }

    expect(after.updated_at).not.toBe(before.updated_at)
  })

  it("does not bump updated_at when skipUpdatedAt is true", () => {
    const db = createTestDb()
    const id = crypto.randomUUID()
    db.prepare(
      "INSERT INTO tasks (id, project_id, repo_url, source, title, status, provider, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?, ?, datetime('now', '-1 hour'), datetime('now', '-1 hour'))",
    ).run(id, "test", "manual", "Test", "running", "claude-code")

    const before = db.prepare("SELECT updated_at FROM tasks WHERE id = ?").get(id) as { updated_at: string }
    Effect.runSync(updateTask(db, id, { last_seen_at: new Date().toISOString() }, { skipUpdatedAt: true }))
    const after = db.prepare("SELECT updated_at FROM tasks WHERE id = ?").get(id) as { updated_at: string }

    expect(after.updated_at).toBe(before.updated_at)
  })

  it("markTaskSeen does not bump updated_at", () => {
    const db = createTestDb()
    const id = crypto.randomUUID()
    db.prepare(
      "INSERT INTO tasks (id, project_id, repo_url, source, title, status, provider, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?, ?, datetime('now'), datetime('now'))",
    ).run(id, "test", "manual", "Test", "running", "claude-code")

    const before = db.prepare("SELECT updated_at FROM tasks WHERE id = ?").get(id) as { updated_at: string }
    Effect.runSync(markTaskSeen(db, id))
    const after = db.prepare("SELECT updated_at, last_seen_at FROM tasks WHERE id = ?").get(id) as { updated_at: string; last_seen_at: string }

    expect(after.updated_at).toBe(before.updated_at)
    expect(after.last_seen_at).toBeTruthy()
  })

  it("markTaskResult does not bump updated_at", () => {
    const db = createTestDb()
    const id = crypto.randomUUID()
    db.prepare(
      "INSERT INTO tasks (id, project_id, repo_url, source, title, status, provider, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?, ?, datetime('now'), datetime('now'))",
    ).run(id, "test", "manual", "Test", "running", "claude-code")

    const before = db.prepare("SELECT updated_at FROM tasks WHERE id = ?").get(id) as { updated_at: string }
    Effect.runSync(markTaskResult(db, id))
    const after = db.prepare("SELECT updated_at, last_result_at FROM tasks WHERE id = ?").get(id) as { updated_at: string; last_result_at: string }

    expect(after.updated_at).toBe(before.updated_at)
    expect(after.last_result_at).toBeTruthy()
  })
})
