import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createTestDb } from "./helpers"
import * as dbQueries from "../db/queries"
import type { LifecycleDeps } from "../tasks/lifecycle"
import { reprovisionTasksForProject, type TaskManagerDeps } from "../tasks/manager"

function makeReprovisionDeps(db: Database): TaskManagerDeps {
  return {
    insertTask: (task) => dbQueries.createTask(db, task),
    updateTask: (id, updates) => dbQueries.updateTask(db, id, updates),
    getTask: (id) => dbQueries.getTask(db, id).pipe(Effect.mapError((e) => e as unknown as Error)),
    listTasks: (filter) => dbQueries.listTasks(db, filter ?? {}).pipe(Effect.mapError((e) => e as unknown as Error)),
    logActivity: () => Effect.succeed(undefined),
    lifecycleDeps: { db } as TaskManagerDeps["lifecycleDeps"],
    cleanupDeps: {} as TaskManagerDeps["cleanupDeps"],
    retryDeps: {} as TaskManagerDeps["retryDeps"],
    getProjectConfig: () => ({ repo: "https://github.com/test/repo", setup: "echo ok", defaultBranch: "main", defaultAgent: "acp" }),
    abortAgent: () => Effect.void,
  }
}

/**
 * Test the review task base branch resolution logic.
 * lifecycle.ts uses deps.getTask() to look up the parent's branch.
 * We verify the getTask interface returns the branch field correctly.
 */
describe("review task base branch resolution", () => {
  function makeGetTask(db: ReturnType<typeof createTestDb>): LifecycleDeps["getTask"] {
    return (id) => dbQueries.getTask(db, id).pipe(Effect.mapError((e) => e as unknown as Error))
  }

  test("getTask returns parent branch for base branch resolution", () => {
    const db = createTestDb()
    const getTask = makeGetTask(db)

    Effect.runSync(dbQueries.createTask(db, {
      id: "parent-111",
      project_id: "test-project",
      source: "manual",
      title: "Parent task",
      branch: "tangerine/parent-br",
    }))

    // Simulate what lifecycle.ts does: look up parent via deps.getTask
    const parent = Effect.runSync(getTask("parent-111"))
    expect(parent?.branch).toBe("tangerine/parent-br")
  })

  test("getTask returns null branch when parent has none", () => {
    const db = createTestDb()
    const getTask = makeGetTask(db)

    Effect.runSync(dbQueries.createTask(db, {
      id: "parent-222",
      project_id: "test-project",
      source: "manual",
      title: "Parent task",
    }))

    const parent = Effect.runSync(getTask("parent-222"))
    expect(parent?.branch).toBeNull()
  })

  test("getTask returns null for nonexistent parent", () => {
    const db = createTestDb()
    const getTask = makeGetTask(db)

    const parent = Effect.runSync(getTask("nonexistent"))
    expect(parent).toBeNull()
  })

  test("continuation task stores parent_task_id correctly", () => {
    const db = createTestDb()

    Effect.runSync(dbQueries.createTask(db, {
      id: "parent-333",
      project_id: "test-project",
      source: "manual",
      title: "Parent task",
      branch: "tangerine/parent-br",
    }))

    const child = Effect.runSync(dbQueries.createTask(db, {
      id: "child-333",
      project_id: "test-project",
      source: "manual",
      title: "Continue parent",
      parent_task_id: "parent-333",
    }))

    expect(child.parent_task_id).toBe("parent-333")
  })
})

describe("reprovisionTasksForProject", () => {
  test("reprovisions runner tasks", async () => {
    const db = createTestDb()
    const deps = makeReprovisionDeps(db)

    await Effect.runPromise(dbQueries.createTask(db, {
      id: "runner-1",
      project_id: "test-project",
      source: "manual",
      title: "Run diagnostics",
      type: "runner",
    }))
    await Effect.runPromise(dbQueries.updateTask(db, "runner-1", {
      status: "running",
      agent_session_id: "runner-session",
      agent_pid: 123,
      worktree_path: "/tmp/runner-worktree",
    }))

    await Effect.runPromise(dbQueries.createTask(db, {
      id: "runner-2",
      project_id: "test-project",
      source: "manual",
      title: "Run cleanup",
      type: "runner",
    }))
    await Effect.runPromise(dbQueries.updateTask(db, "runner-2", {
      status: "running",
      agent_session_id: "runner-session-2",
      agent_pid: 456,
      worktree_path: "/tmp/main-repo",
    }))

    const result = await Effect.runPromise(reprovisionTasksForProject(deps, "test-project"))

    expect(result).toEqual({ reprovisioned: 2, failed: 0 })

    const runner = await Effect.runPromise(dbQueries.getTask(db, "runner-1"))
    expect(runner?.status).toBe("created")
    expect(runner?.agent_session_id).toBeNull()
    expect(runner?.agent_pid).toBeNull()
    expect(runner?.worktree_path).toBeNull()

    const secondRunner = await Effect.runPromise(dbQueries.getTask(db, "runner-2"))
    expect(secondRunner?.status).toBe("created")
    expect(secondRunner?.agent_session_id).toBeNull()
    expect(secondRunner?.agent_pid).toBeNull()
    expect(secondRunner?.worktree_path).toBeNull()
  })
})
