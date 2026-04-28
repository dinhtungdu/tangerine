import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { logActivity, updateToolActivity } from "../activity"
import { onTaskEvent } from "../tasks/events"
import { createTestDb } from "./helpers"

describe("updateToolActivity", () => {
  test("merges tool call updates into the existing activity and broadcasts the updated row", async () => {
    const db = createTestDb()
    db.prepare("INSERT INTO tasks (id, project_id, source, title, status, provider) VALUES (?, ?, ?, ?, ?, ?)")
      .run("task-1", "test", "manual", "Tool task", "running", "acp")
    const created = await Effect.runPromise(logActivity(db, "task-1", "system", "tool.bash", "Bash", {
      toolCallId: "call-1",
      toolName: "Bash",
      toolInput: "{\"command\":\"bun test\"}",
      status: "running",
    }))
    const events: unknown[] = []
    const unsubscribe = onTaskEvent("task-1", (event) => events.push(event))

    const updated = await Effect.runPromise(updateToolActivity(db, "task-1", {
      toolCallId: "call-1",
      status: "success",
      toolResult: "2 tests passed",
    }))
    unsubscribe()

    expect(updated?.id).toBe(created.id)
    expect(updated?.metadata).toMatchObject({
      toolCallId: "call-1",
      toolName: "Bash",
      toolInput: "{\"command\":\"bun test\"}",
      status: "success",
      output: "2 tests passed",
    })
    expect(typeof updated?.metadata?.lastProgressAt).toBe("string")
    expect(events).toEqual([{ type: "activity", entry: updated }])
  })

  test("preserves the activity timestamp and tracks progress freshness", async () => {
    const db = createTestDb()
    db.prepare("INSERT INTO tasks (id, project_id, source, title, status, provider) VALUES (?, ?, ?, ?, ?, ?)")
      .run("task-1", "test", "manual", "Tool task", "running", "acp")
    db.prepare("INSERT INTO activity_log (task_id, type, event, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?)")
      .run("task-1", "system", "tool.bash", "Bash", JSON.stringify({ toolCallId: "call-1", status: "running" }), "2000-01-01 00:00:00")

    const updated = await Effect.runPromise(updateToolActivity(db, "task-1", {
      toolCallId: "call-1",
      status: "running",
      toolResult: "still running",
    }))

    expect(updated).not.toBeNull()
    expect(updated!.timestamp).toBe("2000-01-01T00:00:00Z")
    const lastProgressAt = updated!.metadata?.lastProgressAt
    expect(typeof lastProgressAt).toBe("string")
    expect(Date.parse(lastProgressAt as string)).toBeGreaterThan(Date.parse(updated!.timestamp))
  })

  test("does not refresh progress freshness for status-only heartbeats", async () => {
    const db = createTestDb()
    db.prepare("INSERT INTO tasks (id, project_id, source, title, status, provider) VALUES (?, ?, ?, ?, ?, ?)")
      .run("task-1", "test", "manual", "Tool task", "running", "acp")
    db.prepare("INSERT INTO activity_log (task_id, type, event, content, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?)")
      .run("task-1", "system", "tool.bash", "Bash", JSON.stringify({ toolCallId: "call-1", status: "running", lastProgressAt: "2026-04-27T10:00:00.000Z" }), "2026-04-27 10:00:00")

    const updated = await Effect.runPromise(updateToolActivity(db, "task-1", {
      toolCallId: "call-1",
      status: "running",
    }))

    expect(updated?.metadata?.lastProgressAt).toBe("2026-04-27T10:00:00.000Z")
  })

  test("creates a tool activity when update arrives before tool start", async () => {
    const db = createTestDb()
    db.prepare("INSERT INTO tasks (id, project_id, source, title, status, provider) VALUES (?, ?, ?, ?, ?, ?)")
      .run("task-1", "test", "manual", "Tool task", "running", "acp")
    const events: unknown[] = []
    const unsubscribe = onTaskEvent("task-1", (event) => events.push(event))

    const created = await Effect.runPromise(updateToolActivity(db, "task-1", {
      toolCallId: "call-1",
      toolName: "Bash",
      toolInput: "{\"command\":\"bun test\"}",
      toolResult: "1/2 tests passed",
      status: "running",
      activityType: "system",
      activityEvent: "tool.bash",
    }))
    unsubscribe()

    expect(created?.event).toBe("tool.bash")
    expect(created?.metadata).toMatchObject({
      toolCallId: "call-1",
      toolName: "Bash",
      toolInput: "{\"command\":\"bun test\"}",
      status: "running",
      output: "1/2 tests passed",
    })
    expect(typeof created?.metadata?.lastProgressAt).toBe("string")
    expect(events).toEqual([{ type: "activity", entry: created }])
  })

  test("merges a late tool start into an existing best-effort activity", async () => {
    const db = createTestDb()
    db.prepare("INSERT INTO tasks (id, project_id, source, title, status, provider) VALUES (?, ?, ?, ?, ?, ?)")
      .run("task-1", "test", "manual", "Tool task", "running", "acp")
    const created = await Effect.runPromise(updateToolActivity(db, "task-1", {
      toolCallId: "call-1",
      toolName: "call-1",
      status: "running",
      activityType: "system",
      activityEvent: "tool.other",
    }))

    const merged = await Effect.runPromise(updateToolActivity(db, "task-1", {
      toolCallId: "call-1",
      toolName: "Bash",
      toolInput: "{\"command\":\"bun test\"}",
      status: "running",
      activityType: "system",
      activityEvent: "tool.bash",
    }))
    const count = db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE task_id = ?").get("task-1") as { count: number }

    expect(merged?.id).toBe(created?.id)
    expect(merged?.event).toBe("tool.bash")
    expect(merged?.content).toBe("Bash")
    expect(merged?.metadata).toMatchObject({
      toolCallId: "call-1",
      toolName: "Bash",
      toolInput: "{\"command\":\"bun test\"}",
      status: "running",
    })
    expect(count.count).toBe(1)
  })

  test("does not downgrade a terminal result when a delayed tool start arrives", async () => {
    const db = createTestDb()
    db.prepare("INSERT INTO tasks (id, project_id, source, title, status, provider) VALUES (?, ?, ?, ?, ?, ?)")
      .run("task-1", "test", "manual", "Tool task", "running", "acp")
    const completed = await Effect.runPromise(updateToolActivity(db, "task-1", {
      toolCallId: "call-1",
      toolName: "call-1",
      toolResult: "done",
      status: "success",
      activityType: "system",
      activityEvent: "tool.other",
    }))

    const lateStart = await Effect.runPromise(updateToolActivity(db, "task-1", {
      toolCallId: "call-1",
      toolName: "Bash",
      toolInput: "{\"command\":\"bun test\"}",
      status: "running",
      activityType: "system",
      activityEvent: "tool.bash",
    }))

    expect(lateStart?.id).toBe(completed?.id)
    expect(lateStart?.event).toBe("tool.bash")
    expect(lateStart?.metadata).toMatchObject({
      toolCallId: "call-1",
      toolName: "Bash",
      toolInput: "{\"command\":\"bun test\"}",
      status: "success",
      output: "done",
    })
  })
})
