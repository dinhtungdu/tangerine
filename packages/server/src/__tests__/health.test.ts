import { describe, test, expect, mock } from "bun:test"
import { Effect } from "effect"
import { checkTask } from "../tasks/health"
import type { HealthCheckDeps } from "../tasks/health"
import type { TaskRow } from "../db/types"

function makeTask(overrides?: Partial<TaskRow>): TaskRow {
  return {
    id: "test-task-1",
    project_id: "test-project",
    source: "manual",
    source_id: null,
    source_url: null,
    repo_url: "https://github.com/test/repo",
    title: "Test task",
    description: null,
    status: "running",
    provider: "claude-code",
    model: null,
    reasoning_effort: null,
    branch: "test-branch",
    worktree_path: "/tmp/test-worktree",
    pr_url: null,
    user_id: null,
    agent_session_id: "test-session",
    agent_pid: 12345,
    preview_url: null,
    error: null,
    created_at: "2026-03-27T00:00:00Z",
    updated_at: "2026-03-27T00:00:00Z",
    started_at: "2026-03-27T00:00:00Z",
    completed_at: null,
    last_seen_at: null,
    ...overrides,
  }
}

function makeDeps(overrides?: Partial<HealthCheckDeps>): HealthCheckDeps {
  return {
    listRunningTasks: () => Effect.succeed([]),
    checkAgentAlive: () => Effect.succeed(true),
    getLastActivityTime: () => Effect.succeed(new Date()),
    restartAgent: () => Effect.void,
    failTask: () => Effect.void,
    cleanupDeps: {
      db: null as never,
      getTask: () => Effect.succeed(null),
      updateTask: () => Effect.void,
      getAgentHandle: () => null,
    },
    ...overrides,
  }
}

describe("health check", () => {
  test("healthy task returns healthy", async () => {
    const task = makeTask()
    const deps = makeDeps()
    const result = await Effect.runPromise(checkTask(task, deps))
    expect(result).toBe("healthy")
  })

  test("dead agent triggers restart and verifies recovery", async () => {
    const task = makeTask()
    const restartFn = mock(() => Effect.void)
    // After restart, agent is alive
    let callCount = 0
    const deps = makeDeps({
      checkAgentAlive: () => Effect.succeed(callCount++ > 0),
      restartAgent: restartFn,
    })
    const result = await Effect.runPromise(checkTask(task, deps))
    expect(result).toBe("recovered")
    expect(restartFn).toHaveBeenCalledTimes(1)
  })

  test("restart that fails to produce live agent force-fails the task", async () => {
    const task = makeTask()
    const failFn = mock(() => Effect.void)
    // Agent is never alive — checkAgentAlive always returns false
    const deps = makeDeps({
      checkAgentAlive: () => Effect.succeed(false),
      restartAgent: () => Effect.void,
      failTask: failFn,
    })
    const result = await Effect.runPromise(checkTask(task, deps))
    // The task was force-failed but attemptRestart still returns "recovered"
    // because restartAgent returned success — the force-fail is a side-effect
    expect(result).toBe("recovered")
    expect(failFn).toHaveBeenCalledTimes(1)
    expect((failFn.mock.calls[0] as unknown as [string, string])[0]).toBe("test-task-1")
  })

  test("stall detection with null lastActivity falls back to started_at", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const task = makeTask({ started_at: tenMinutesAgo })
    const restartFn = mock(() => Effect.void)
    let callCount = 0
    const deps = makeDeps({
      checkAgentAlive: () => Effect.succeed(callCount++ === 0),
      getLastActivityTime: () => Effect.succeed(null),
      restartAgent: restartFn,
    })
    const result = await Effect.runPromise(checkTask(task, deps))
    expect(result).toBe("recovered")
    expect(restartFn).toHaveBeenCalledTimes(1)
  })

  test("stall detection does not trigger for recently started tasks with no activity", async () => {
    const task = makeTask({ started_at: new Date().toISOString() })
    const restartFn = mock(() => Effect.void)
    const deps = makeDeps({
      checkAgentAlive: () => Effect.succeed(true),
      getLastActivityTime: () => Effect.succeed(null),
      restartAgent: restartFn,
    })
    const result = await Effect.runPromise(checkTask(task, deps))
    expect(result).toBe("healthy")
    expect(restartFn).toHaveBeenCalledTimes(0)
  })
})
