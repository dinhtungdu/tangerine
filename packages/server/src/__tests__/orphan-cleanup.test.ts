import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { findOrphans } from "../tasks/orphan-cleanup"
import type { TaskRow } from "../db/types"

function makeTask(overrides: Partial<TaskRow>): TaskRow {
  return {
    id: "t1",
    project_id: "p1",
    title: "test",
    status: "done",
    worktree_path: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pr_url: null,
    branch: null,
    base_branch: null,
    prompt: null,
    type: "worker",
    capabilities: "[]",
    agent_pid: null,
    error: null,
    pr_number: null,
    ...overrides,
  } as TaskRow
}

function makeDeps(tasksByStatus: Record<string, TaskRow[]>) {
  return {
    listTasks: (filter?: { status?: string }) =>
      Effect.succeed(filter?.status ? (tasksByStatus[filter.status] ?? []) : []),
    cleanupDeps: {} as never,
  }
}

describe("findOrphans", () => {
  it("returns terminal tasks that have a worktree_path", async () => {
    const task = makeTask({ id: "t1", status: "done", worktree_path: "/wt/1" })
    const deps = makeDeps({ done: [task] })
    const result = await Effect.runPromise(findOrphans(deps))
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("t1")
  })

  it("excludes terminal tasks without a worktree_path", async () => {
    const task = makeTask({ id: "t1", status: "done", worktree_path: null })
    const deps = makeDeps({ done: [task] })
    const result = await Effect.runPromise(findOrphans(deps))
    expect(result).toHaveLength(0)
  })

  it("excludes orphan whose worktree_path is held by a running task", async () => {
    const orphan = makeTask({ id: "t1", status: "done", worktree_path: "/wt/shared" })
    const active = makeTask({ id: "t2", status: "running", worktree_path: "/wt/shared" })
    const deps = makeDeps({ done: [orphan], running: [active] })
    const result = await Effect.runPromise(findOrphans(deps))
    expect(result).toHaveLength(0)
  })

  it("excludes orphan whose worktree_path is held by a pending task", async () => {
    const orphan = makeTask({ id: "t1", status: "failed", worktree_path: "/wt/shared" })
    const active = makeTask({ id: "t2", status: "pending", worktree_path: "/wt/shared" })
    const deps = makeDeps({ failed: [orphan], pending: [active] })
    const result = await Effect.runPromise(findOrphans(deps))
    expect(result).toHaveLength(0)
  })

  it("excludes orphan whose worktree_path is held by a created task", async () => {
    const orphan = makeTask({ id: "t1", status: "cancelled", worktree_path: "/wt/shared" })
    const active = makeTask({ id: "t2", status: "created", worktree_path: "/wt/shared" })
    const deps = makeDeps({ cancelled: [orphan], created: [active] })
    const result = await Effect.runPromise(findOrphans(deps))
    expect(result).toHaveLength(0)
  })

  it("keeps orphan when its worktree_path is not held by any active task", async () => {
    const orphan = makeTask({ id: "t1", status: "done", worktree_path: "/wt/orphan" })
    const active = makeTask({ id: "t2", status: "running", worktree_path: "/wt/other" })
    const deps = makeDeps({ done: [orphan], running: [active] })
    const result = await Effect.runPromise(findOrphans(deps))
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("t1")
  })
})
