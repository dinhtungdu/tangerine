import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createTestDb } from "./helpers"
import { createTask, getTask, updateTask } from "../db/queries"
import { cleanupSession } from "../tasks/cleanup"
import type { AgentHandle } from "../agent/provider"

describe("cleanupSession", () => {
  test("removes retained agent handle after shutdown", async () => {
    const db = createTestDb()
    await Effect.runPromise(createTask(db, {
      id: "cleanup-handle-task",
      project_id: "test-project",
      source: "manual",
      title: "Cleanup handle",
    }))
    await Effect.runPromise(updateTask(db, "cleanup-handle-task", {
      status: "running",
      worktree_path: "/tmp/cleanup-handle-task",
    }))

    let shutdowns = 0
    let removed = false
    const handle: AgentHandle = {
      sendPrompt: () => Effect.void,
      abort: () => Effect.void,
      subscribe: () => ({ unsubscribe() {} }),
      shutdown: () => Effect.sync(() => { shutdowns++ }),
    }
    const deps = {
      db,
      getTask: (taskId: string) => getTask(db, taskId).pipe(Effect.mapError((e) => e as unknown as Error)),
      updateTask: (taskId: string, updates: Parameters<typeof updateTask>[2]) => updateTask(db, taskId, updates).pipe(Effect.asVoid, Effect.mapError((e) => e as unknown as Error)),
      getAgentHandle: () => handle,
      removeAgentHandle: (taskId: string) => {
        if (taskId === "cleanup-handle-task") removed = true
      },
    }

    await Effect.runPromise(cleanupSession("cleanup-handle-task", deps))

    expect(shutdowns).toBe(1)
    expect(removed).toBe(true)
  })
})
