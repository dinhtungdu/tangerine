import { describe, test, expect, mock } from "bun:test"
import { Effect } from "effect"
import { computeNextRun, pollCrons } from "../tasks/scheduler"
import type { SchedulerDeps } from "../tasks/scheduler"
import type { CronRow, TaskRow } from "../db/types"

function makeCron(overrides?: Partial<CronRow>): CronRow {
  return {
    id: "cron-1",
    project_id: "test",
    title: "Nightly check",
    description: "Run nightly checks",
    cron: "0 9 * * 1-5",
    enabled: 1,
    next_run_at: new Date(Date.now() - 60000).toISOString(), // 1 minute ago (due)
    task_defaults: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeTask(overrides?: Partial<TaskRow>): TaskRow {
  const now = new Date().toISOString()
  return {
    id: "task-1",
    project_id: "test",
    source: "cron",
    source_id: "cron:cron-1",
    source_url: null,
    title: "Nightly check",
    type: "worker",
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
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    last_seen_at: null,
    last_result_at: null,
    capabilities: null,
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

describe("pollCrons", () => {
  test("returns 0 when no crons are due", async () => {
    const deps: SchedulerDeps = {
      getDueCrons: () => Effect.succeed([]),
      hasActiveCronTask: () => Effect.succeed(false),
      createWorkerFromCron: () => Effect.succeed(makeTask()),
      updateCron: () => Effect.succeed(null),
    }
    const count = await Effect.runPromise(pollCrons(deps))
    expect(count).toBe(0)
  })

  test("spawns a worker task for a due cron", async () => {
    const cron = makeCron()
    const createMock = mock(() => Effect.succeed(makeTask()))
    const updateMock = mock(() => Effect.succeed(null as CronRow | null))

    const deps: SchedulerDeps = {
      getDueCrons: () => Effect.succeed([cron]),
      hasActiveCronTask: () => Effect.succeed(false),
      createWorkerFromCron: createMock,
      updateCron: updateMock,
    }

    const count = await Effect.runPromise(pollCrons(deps))
    expect(count).toBe(1)
    expect(createMock).toHaveBeenCalledTimes(1)
    // Should update next_run_at
    expect(updateMock).toHaveBeenCalled()
  })

  test("skips cron when a task is already active", async () => {
    const cron = makeCron()
    const createMock = mock(() => Effect.succeed(makeTask()))

    const deps: SchedulerDeps = {
      getDueCrons: () => Effect.succeed([cron]),
      hasActiveCronTask: () => Effect.succeed(true),
      createWorkerFromCron: createMock,
      updateCron: () => Effect.succeed(null),
    }

    const count = await Effect.runPromise(pollCrons(deps))
    expect(count).toBe(1)
    // createWorkerFromCron should NOT have been called since a task is active
    expect(createMock).toHaveBeenCalledTimes(0)
  })

  test("allows spawn when previous tasks are all terminal", async () => {
    const cron = makeCron()
    const createMock = mock(() => Effect.succeed(makeTask()))

    const deps: SchedulerDeps = {
      getDueCrons: () => Effect.succeed([cron]),
      hasActiveCronTask: () => Effect.succeed(false),
      createWorkerFromCron: createMock,
      updateCron: () => Effect.succeed(null),
    }

    await Effect.runPromise(pollCrons(deps))
    expect(createMock).toHaveBeenCalledTimes(1)
  })
})
