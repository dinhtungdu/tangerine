import { describe, it, expect, beforeEach } from "bun:test"
import type { Database } from "bun:sqlite"
import { Effect } from "effect"
import type { StreamEvent } from "@tangerine/shared"
import { createTestDb } from "./helpers"
import {
  createTask,
  getTask,
  updateTask,
  updateTaskStatus,
  insertStreamEvent,
  getStreamEvents,
} from "../db/queries"

/**
 * Tracer bullet: Task creation -> Status transitions -> Stream events
 *
 * Validates the full task lifecycle through DB state transitions,
 * including stream event tracking and retrieval.
 */
describe("tracer: task lifecycle", () => {
  let db: Database

  beforeEach(() => {
    db = createTestDb()
  })

  it("walks through the full happy-path lifecycle", () => {
    // 1. Create task (status: created)
    const task = Effect.runSync(createTask(db, {
      id: "task-lifecycle",
      source: "github",
      project_id: "test",
      title: "Implement feature X",
      description: "Full lifecycle test",
      source_id: "test/repo#1",
      source_url: "https://github.com/test/repo/issues/1",
    }))
    expect(task.status).toBe("created")
    expect(task.agent_session_id).toBeNull()

    // 2. Simulate provisioning (update status)
    const provisioning = Effect.runSync(updateTaskStatus(db, "task-lifecycle", "provisioning"))
    expect(provisioning!.status).toBe("provisioning")

    // 3. Simulate running (update agent session fields)
    const running = Effect.runSync(updateTask(db, "task-lifecycle", {
      status: "running",
      agent_session_id: "session-123",
      agent_pid: 12345,
      started_at: new Date().toISOString(),
    }))
    expect(running!.status).toBe("running")
    expect(running!.agent_session_id).toBe("session-123")
    expect(running!.agent_pid).toBe(12345)
    expect(running!.started_at).toBeDefined()

    // 4. Insert stream events (simulate chat messages)
    const userEvent: StreamEvent = {
      type: "user.message",
      id: "u1",
      content: "Implement feature X with tests",
    }
    const chunkStart: StreamEvent = {
      type: "chunk.start",
      messageId: "m1",
      chunkIndex: 0,
      chunkType: "message",
      content: "I'll start by creating the feature module...",
    }
    const assistantDone: StreamEvent = {
      type: "assistant.done",
      messageId: "m1",
    }

    Effect.runSync(insertStreamEvent(db, "task-lifecycle", userEvent))
    Effect.runSync(insertStreamEvent(db, "task-lifecycle", chunkStart))
    Effect.runSync(insertStreamEvent(db, "task-lifecycle", assistantDone))

    // 5. Retrieve stream events and verify order
    const events = Effect.runSync(getStreamEvents(db, "task-lifecycle"))
    expect(events).toHaveLength(3)
    expect(events[0]!.type).toBe("user.message")
    expect(events[1]!.type).toBe("chunk.start")
    expect(events[2]!.type).toBe("assistant.done")

    // 6. Simulate completion (set status to done, set pr_url)
    const done = Effect.runSync(updateTask(db, "task-lifecycle", {
      status: "done",
      pr_url: "https://github.com/test/repo/pull/42",
      branch: "feat/feature-x",
      completed_at: new Date().toISOString(),
    }))
    expect(done!.status).toBe("done")
    expect(done!.pr_url).toBe("https://github.com/test/repo/pull/42")
    expect(done!.branch).toBe("feat/feature-x")
    expect(done!.completed_at).toBeDefined()

    // 7. Verify full task history is retrievable
    const final = Effect.runSync(getTask(db, "task-lifecycle"))!
    expect(final.source).toBe("github")
    expect(final.source_id).toBe("test/repo#1")
    expect(final.status).toBe("done")
    expect(final.agent_session_id).toBe("session-123")
    expect(final.pr_url).toBe("https://github.com/test/repo/pull/42")
    expect(final.created_at).toBeDefined()
    expect(final.started_at).toBeDefined()
    expect(final.completed_at).toBeDefined()
  })

  it("handles the cancellation flow", () => {
    Effect.runSync(createTask(db, {
      id: "task-cancel",
      source: "manual",
      project_id: "test",
      title: "Task to cancel",
    }))

    // Move to running
    Effect.runSync(updateTaskStatus(db, "task-cancel", "running"))

    // Insert an event before cancellation
    const userEvent: StreamEvent = {
      type: "user.message",
      id: "u1",
      content: "Start working on this",
    }
    Effect.runSync(insertStreamEvent(db, "task-cancel", userEvent))

    // Cancel the task
    const cancelled = Effect.runSync(updateTask(db, "task-cancel", {
      status: "cancelled",
      completed_at: new Date().toISOString(),
    }))
    expect(cancelled!.status).toBe("cancelled")
    expect(cancelled!.completed_at).toBeDefined()

    // Events should still be retrievable after cancellation
    const events = Effect.runSync(getStreamEvents(db, "task-cancel"))
    expect(events).toHaveLength(1)
    expect((events[0] as { content?: string }).content).toBe("Start working on this")
  })

  it("handles the failure flow with error message", () => {
    Effect.runSync(createTask(db, {
      id: "task-fail",
      source: "github",
      project_id: "test",
      title: "Task that fails",
    }))

    Effect.runSync(updateTaskStatus(db, "task-fail", "provisioning"))

    // Simulate failure during provisioning
    const failed = Effect.runSync(updateTask(db, "task-fail", {
      status: "failed",
      error: "Agent process crashed with exit code 1",
      completed_at: new Date().toISOString(),
    }))
    expect(failed!.status).toBe("failed")
    expect(failed!.error).toBe("Agent process crashed with exit code 1")
    expect(failed!.completed_at).toBeDefined()

    // Verify error is persisted
    const retrieved = Effect.runSync(getTask(db, "task-fail"))!
    expect(retrieved.error).toBe("Agent process crashed with exit code 1")
    expect(retrieved.status).toBe("failed")
  })

  it("tracks multiple tasks with different statuses", () => {
    Effect.runSync(createTask(db, { id: "t1", source: "manual", project_id: "test", title: "Task 1" }))
    Effect.runSync(createTask(db, { id: "t2", source: "github", project_id: "test", title: "Task 2" }))
    Effect.runSync(createTask(db, { id: "t3", source: "manual", project_id: "test", title: "Task 3" }))

    Effect.runSync(updateTaskStatus(db, "t1", "running"))
    Effect.runSync(updateTaskStatus(db, "t2", "done"))
    // t3 stays as "created"

    const t1 = Effect.runSync(getTask(db, "t1"))!
    const t2 = Effect.runSync(getTask(db, "t2"))!
    const t3 = Effect.runSync(getTask(db, "t3"))!

    expect(t1.status).toBe("running")
    expect(t2.status).toBe("done")
    expect(t3.status).toBe("created")
  })

  it("stream events are isolated per task", () => {
    Effect.runSync(createTask(db, { id: "ta", source: "manual", project_id: "test", title: "A" }))
    Effect.runSync(createTask(db, { id: "tb", source: "manual", project_id: "test", title: "B" }))

    const evA1: StreamEvent = { type: "user.message", id: "ua1", content: "Event for A" }
    const evB1: StreamEvent = { type: "user.message", id: "ub1", content: "Event for B" }
    const evA2: StreamEvent = { type: "chunk.start", messageId: "ma1", chunkIndex: 0, chunkType: "message", content: "Reply for A" }

    Effect.runSync(insertStreamEvent(db, "ta", evA1))
    Effect.runSync(insertStreamEvent(db, "tb", evB1))
    Effect.runSync(insertStreamEvent(db, "ta", evA2))

    const eventsA = Effect.runSync(getStreamEvents(db, "ta"))
    const eventsB = Effect.runSync(getStreamEvents(db, "tb"))

    expect(eventsA).toHaveLength(2)
    expect(eventsB).toHaveLength(1)
    expect((eventsA[0] as { content?: string }).content).toBe("Event for A")
    expect((eventsB[0] as { content?: string }).content).toBe("Event for B")
  })
})
