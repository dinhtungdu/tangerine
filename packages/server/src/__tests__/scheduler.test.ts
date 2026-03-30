import { describe, test, expect, mock } from "bun:test"
import { Effect } from "effect"
import { computeNextRun, pollScheduledTasks } from "../tasks/scheduler"
import type { SchedulerDeps } from "../tasks/scheduler"
import type { TaskRow } from "../db/types"

function makeScheduledTask(overrides?: Partial<TaskRow>): TaskRow {
  const now = new Date().toISOString()
  return {
    id: "sched-1",
    project_id: "test",
    source: "manual",
    source_id: null,
    source_url: null,
    repo_url: "https://github.com/test/repo",
    title: "Nightly check",
    type: "scheduled",
    description: "Run nightly checks",
    status: "created",
    provider: "claude-code",
    model: "claude-sonnet-4-6",
    reasoning_effort: null,
    branch: null,
    worktree_path: null,
    pr_url: null,
    parent_task_id: null,
    user_id: null,
    agent_session_id: null,
    agent_pid: null,
    error: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    last_seen_at: null,
    last_result_at: null,
    capabilities: '["schedule"]',
    cron_expression: "0 9 * * 1-5",
    schedule_enabled: 1,
    next_run_at: new Date(Date.now() - 60000).toISOString(), // 1 minute ago (due)
    ...overrides,
  }
}

function makeChildTask(overrides?: Partial<TaskRow>): TaskRow {
  return {
    ...makeScheduledTask({ id: "child-1", type: "worker", status: "running", parent_task_id: "sched-1" }),
    cron_expression: null,
    schedule_enabled: 0,
    next_run_at: null,
    ...overrides,
  }
}

describe("computeNextRun", () => {
  test("returns a valid ISO date string", () => {
    const next = computeNextRun("0 9 * * 1-5")
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now() - 1000)
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test("every minute returns a time within 60s", () => {
    const next = computeNextRun("* * * * *")
    const diff = new Date(next).getTime() - Date.now()
    expect(diff).toBeLessThanOrEqual(60_000)
    expect(diff).toBeGreaterThan(0)
  })
})

describe("pollScheduledTasks", () => {
  test("returns 0 when no tasks are due", async () => {
    const deps: SchedulerDeps = {
      getDueScheduledTasks: () => Effect.succeed([]),
      getChildTasks: () => Effect.succeed([]),
      createChildWorker: () => Effect.succeed(makeChildTask()),
      updateTask: () => Effect.succeed(null),
      logActivity: () => Effect.succeed(undefined),
    }
    const count = await Effect.runPromise(pollScheduledTasks(deps))
    expect(count).toBe(0)
  })

  test("spawns a child worker for a due task", async () => {
    const task = makeScheduledTask()
    const createChildMock = mock(() => Effect.succeed(makeChildTask()))
    const updateTaskMock = mock(() => Effect.succeed(null as TaskRow | null))

    const deps: SchedulerDeps = {
      getDueScheduledTasks: () => Effect.succeed([task]),
      getChildTasks: () => Effect.succeed([]),
      createChildWorker: createChildMock,
      updateTask: updateTaskMock,
      logActivity: () => Effect.succeed(undefined),
    }

    const count = await Effect.runPromise(pollScheduledTasks(deps))
    expect(count).toBe(1)
    expect(createChildMock).toHaveBeenCalledTimes(1)
    // Should update next_run_at
    expect(updateTaskMock).toHaveBeenCalled()
  })

  test("skips task when a child is already active", async () => {
    const task = makeScheduledTask()
    const activeChild = makeChildTask({ status: "running" })
    const createChildMock = mock(() => Effect.succeed(makeChildTask()))

    const deps: SchedulerDeps = {
      getDueScheduledTasks: () => Effect.succeed([task]),
      getChildTasks: () => Effect.succeed([activeChild]),
      createChildWorker: createChildMock,
      updateTask: () => Effect.succeed(null),
      logActivity: () => Effect.succeed(undefined),
    }

    const count = await Effect.runPromise(pollScheduledTasks(deps))
    expect(count).toBe(1)
    // createChildWorker should NOT have been called since a child is active
    expect(createChildMock).toHaveBeenCalledTimes(0)
  })

  test("allows spawn when previous children are all terminal", async () => {
    const task = makeScheduledTask()
    const doneChild = makeChildTask({ status: "done" })
    const createChildMock = mock(() => Effect.succeed(makeChildTask()))

    const deps: SchedulerDeps = {
      getDueScheduledTasks: () => Effect.succeed([task]),
      getChildTasks: () => Effect.succeed([doneChild]),
      createChildWorker: createChildMock,
      updateTask: () => Effect.succeed(null),
      logActivity: () => Effect.succeed(undefined),
    }

    await Effect.runPromise(pollScheduledTasks(deps))
    expect(createChildMock).toHaveBeenCalledTimes(1)
  })
})
