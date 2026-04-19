import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createTestDb } from "./helpers"
import { createTask, updateTask, deleteTask } from "../db/queries"
import { onTaskListEvent, setAgentWorkingState, type TaskListEvent } from "../tasks/events"

describe("task-list events", () => {
  let db: Database
  let events: TaskListEvent[]
  let unsub: () => void

  beforeEach(() => {
    db = createTestDb()
    events = []
    unsub = onTaskListEvent((e) => events.push(e))
  })

  afterEach(() => {
    // Guarantee listener cleanup even if a test fails mid-way — the emitter
    // is a module-level singleton, so a leaked listener would bleed into
    // later tests.
    unsub?.()
  })

  test("createTask emits a 'created' event with the new row", () => {
    const id = crypto.randomUUID()
    Effect.runSync(createTask(db, { id, project_id: "p", source: "manual", title: "hi" }))

    const created = events.find((e) => e.kind === "created")
    expect(created).toBeDefined()
    if (created?.kind === "created") {
      expect(created.task.id).toBe(id)
      expect(created.task.project_id).toBe("p")
    }

  })

  test("updateTask emits an 'updated' event with the new row", () => {
    const id = crypto.randomUUID()
    Effect.runSync(createTask(db, { id, project_id: "p", source: "manual", title: "hi" }))
    events.length = 0

    Effect.runSync(updateTask(db, id, { status: "running" }))

    const updated = events.find((e) => e.kind === "updated")
    expect(updated).toBeDefined()
    if (updated?.kind === "updated") {
      expect(updated.task.id).toBe(id)
      expect(updated.task.status).toBe("running")
    }

  })

  test("deleteTask emits a 'deleted' event with projectId", () => {
    const id = crypto.randomUUID()
    Effect.runSync(createTask(db, { id, project_id: "p", source: "manual", title: "hi" }))
    // Transition to a terminal status so delete is allowed
    Effect.runSync(updateTask(db, id, { status: "done" }))
    events.length = 0

    Effect.runSync(deleteTask(db, id))

    expect(events).toHaveLength(1)
    const [e] = events
    expect(e?.kind).toBe("deleted")
    if (e?.kind === "deleted") {
      expect(e.taskId).toBe(id)
      expect(e.projectId).toBe("p")
    }

  })

  test("setAgentWorkingState emits 'agent_status' only on transitions", () => {
    setAgentWorkingState("t1", "working")
    setAgentWorkingState("t1", "working") // no-op: same state
    setAgentWorkingState("t1", "idle")

    const statusEvents = events.filter((e) => e.kind === "agent_status")
    expect(statusEvents).toHaveLength(2)
    if (statusEvents[0]?.kind === "agent_status") expect(statusEvents[0].agentStatus).toBe("working")
    if (statusEvents[1]?.kind === "agent_status") expect(statusEvents[1].agentStatus).toBe("idle")

  })
})
