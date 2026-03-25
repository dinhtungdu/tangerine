import { describe, test, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createTestDb } from "./helpers"
import {
  initPool,
  acquireSlot,
  releaseSlot,
  reconcileStaleSlots,
  deletePoolForProject,
  getSlotForTask,
} from "../tasks/worktree-pool"
import type { WorktreeSlotRow } from "../db/types"

const PROJECT_ID = "proj-1"
const REPO_PATH = "/workspace/repo"

// Mock local exec that always succeeds
const mockExec = () =>
  Effect.succeed({ stdout: "", stderr: "", exitCode: 0 })

// Mock getTask that returns a status
function mockGetTask(statuses: Record<string, string>) {
  return (id: string) =>
    Effect.succeed(statuses[id] ? { status: statuses[id] } : null)
}

function getSlots(db: Database): WorktreeSlotRow[] {
  return db.prepare("SELECT * FROM worktree_slots ORDER BY id").all() as WorktreeSlotRow[]
}

describe("worktree-pool", () => {
  let db: Database

  beforeEach(() => {
    db = createTestDb()
  })

  describe("initPool", () => {
    test("creates N slots", async () => {
      const slots = await Effect.runPromise(
        initPool(db, PROJECT_ID, mockExec, REPO_PATH, 3),
      )
      expect(slots).toHaveLength(3)
      expect(slots.map((s) => s.id)).toEqual(["proj-1-slot-0", "proj-1-slot-1", "proj-1-slot-2"])
      expect(slots.every((s) => s.status === "available")).toBe(true)

      const dbSlots = getSlots(db)
      expect(dbSlots).toHaveLength(3)
    })

    test("is idempotent — skips existing slots", async () => {
      await Effect.runPromise(initPool(db, PROJECT_ID, mockExec, REPO_PATH, 2))
      const slots = await Effect.runPromise(
        initPool(db, PROJECT_ID, mockExec, REPO_PATH, 2),
      )
      expect(slots).toHaveLength(2)
      expect(getSlots(db)).toHaveLength(2)
    })

    test("grows pool when size increases", async () => {
      await Effect.runPromise(initPool(db, PROJECT_ID, mockExec, REPO_PATH, 1))
      expect(getSlots(db)).toHaveLength(1)

      const slots = await Effect.runPromise(
        initPool(db, PROJECT_ID, mockExec, REPO_PATH, 3),
      )
      expect(slots).toHaveLength(3)
      expect(getSlots(db)).toHaveLength(3)
    })
  })

  function insertTask(id: string, status = "running") {
    db.prepare(
      "INSERT INTO tasks (id, project_id, source, repo_url, title, status) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, PROJECT_ID, "manual", "https://github.com/t/r", "Test", status)
  }

  describe("acquireSlot", () => {
    beforeEach(async () => {
      await Effect.runPromise(initPool(db, PROJECT_ID, mockExec, REPO_PATH, 2))
    })

    test("returns available slot and marks bound", async () => {
      insertTask("task-1")
      const slot = await Effect.runPromise(
        acquireSlot(db, PROJECT_ID, "task-1", mockGetTask({})),
      )
      expect(slot.status).toBe("bound")
      expect(slot.task_id).toBe("task-1")
      expect(slot.path).toMatch(/worktrees\/proj-1-slot-\d/)
    })

    test("fails when pool exhausted", async () => {
      insertTask("task-1")
      insertTask("task-2")
      insertTask("task-3")

      await Effect.runPromise(acquireSlot(db, PROJECT_ID, "task-1", mockGetTask({ "task-1": "running", "task-2": "running" })))
      await Effect.runPromise(acquireSlot(db, PROJECT_ID, "task-2", mockGetTask({ "task-1": "running", "task-2": "running" })))

      const result = Effect.runPromise(
        acquireSlot(db, PROJECT_ID, "task-3", mockGetTask({ "task-1": "running", "task-2": "running" })),
      )
      await expect(result).rejects.toThrow(/No worktree slots available/)
    })

    test("reconciles stale slot before failing", async () => {
      insertTask("task-1")
      insertTask("task-2")

      await Effect.runPromise(acquireSlot(db, PROJECT_ID, "task-1", mockGetTask({ "task-1": "running" })))
      await Effect.runPromise(acquireSlot(db, PROJECT_ID, "task-2", mockGetTask({ "task-1": "running", "task-2": "running" })))

      // task-1 is now "done" — stale reconciliation should free its slot
      const slot = await Effect.runPromise(
        acquireSlot(db, PROJECT_ID, "task-2", mockGetTask({ "task-1": "done", "task-2": "done" })),
      )
      expect(slot.status).toBe("bound")
    })
  })

  describe("releaseSlot", () => {
    test("resets slot to available", async () => {
      await Effect.runPromise(initPool(db, PROJECT_ID, mockExec, REPO_PATH, 1))
      insertTask("task-1")
      await Effect.runPromise(acquireSlot(db, PROJECT_ID, "task-1", mockGetTask({})))

      const before = getSlots(db)
      expect(before[0]!.status).toBe("bound")

      await Effect.runPromise(releaseSlot(db, "task-1", mockExec))

      const after = getSlots(db)
      expect(after[0]!.status).toBe("available")
      expect(after[0]!.task_id).toBeNull()
    })

    test("no-ops when task has no slot", async () => {
      // Should not throw
      await Effect.runPromise(releaseSlot(db, "nonexistent", mockExec))
    })
  })

  describe("reconcileStaleSlots", () => {
    test("releases slots bound to terminal tasks", async () => {
      await Effect.runPromise(initPool(db, PROJECT_ID, mockExec, REPO_PATH, 2))
      insertTask("task-1")
      insertTask("task-2")

      await Effect.runPromise(acquireSlot(db, PROJECT_ID, "task-1", mockGetTask({ "task-1": "running", "task-2": "running" })))
      await Effect.runPromise(acquireSlot(db, PROJECT_ID, "task-2", mockGetTask({ "task-1": "running", "task-2": "running" })))

      // Both tasks now done
      const released = await Effect.runPromise(
        reconcileStaleSlots(db, PROJECT_ID, mockGetTask({ "task-1": "done", "task-2": "cancelled" })),
      )
      expect(released).toBe(2)

      const slots = getSlots(db)
      expect(slots.every((s) => s.status === "available")).toBe(true)
    })
  })

  describe("deletePoolForProject", () => {
    test("removes all slots for a project", async () => {
      await Effect.runPromise(initPool(db, PROJECT_ID, mockExec, REPO_PATH, 3))
      expect(getSlots(db)).toHaveLength(3)

      const deleted = await Effect.runPromise(deletePoolForProject(db, PROJECT_ID))
      expect(deleted).toBe(3)
      expect(getSlots(db)).toHaveLength(0)
    })
  })

  describe("getSlotForTask", () => {
    test("returns slot bound to task", async () => {
      await Effect.runPromise(initPool(db, PROJECT_ID, mockExec, REPO_PATH, 1))
      insertTask("task-1")
      await Effect.runPromise(acquireSlot(db, PROJECT_ID, "task-1", mockGetTask({})))

      const slot = await Effect.runPromise(getSlotForTask(db, "task-1"))
      expect(slot).not.toBeNull()
      expect(slot!.task_id).toBe("task-1")
    })

    test("returns null for unbound task", async () => {
      const slot = await Effect.runPromise(getSlotForTask(db, "nonexistent"))
      expect(slot).toBeNull()
    })
  })
})
