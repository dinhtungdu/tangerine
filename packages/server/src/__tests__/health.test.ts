import { describe, test, expect, mock } from "bun:test"
import { Effect } from "effect"
import { checkTask, startHealthMonitor } from "../tasks/health"
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
    parent_task_id: null,
    user_id: null,
    agent_session_id: "test-session",
    agent_pid: 12345,
    error: null,
    created_at: "2026-03-27T00:00:00Z",
    updated_at: "2026-03-27T00:00:00Z",
    started_at: "2026-03-27T00:00:00Z",
    completed_at: null,
    last_seen_at: null,
    last_result_at: null,
    ...overrides,
  }
}

function makeDeps(overrides?: Partial<HealthCheckDeps>): HealthCheckDeps {
  return {
    listRunningTasks: () => Effect.succeed([]),
    checkAgentAlive: () => Effect.succeed(true),
    restartAgent: () => Effect.void,
    failTask: () => Effect.void,
    getLastAgentError: () => undefined,
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

  test("dead agent triggers restart and recovers", async () => {
    const task = makeTask()
    const restartFn = mock(() => Effect.void)
    let callCount = 0
    const deps = makeDeps({
      // First call: dead. After restart succeeds, next health cycle sees alive.
      checkAgentAlive: () => Effect.succeed(callCount++ > 0),
      restartAgent: restartFn,
    })
    const result = await Effect.runPromise(checkTask(task, deps))
    expect(result).toBe("recovered")
    expect(restartFn).toHaveBeenCalledTimes(1)
  })

  test("restart failure marks task as failed", async () => {
    const task = makeTask()
    const failFn = mock(() => Effect.void)
    const deps = makeDeps({
      checkAgentAlive: () => Effect.succeed(false),
      restartAgent: () => Effect.fail(new Error("Agent startup timed out")),
      failTask: failFn,
    })
    // checkTask catches HealthCheckError internally, so it won't throw
    const result = await Effect.runPromise(
      checkTask(task, deps).pipe(Effect.catchAll(() => Effect.succeed("failed" as const)))
    )
    expect(result).toBe("failed")
    expect(failFn).toHaveBeenCalledTimes(1)
    const failReason = (failFn.mock.calls[0] as unknown as [string, string])[1]
    expect(failReason).toContain("Agent startup timed out")
  })

  test("startHealthMonitor fiber survives after runPromise resolves", async () => {
    let checkCount = 0
    const deps = makeDeps({
      listRunningTasks: () => {
        checkCount++
        return Effect.succeed([])
      },
    })
    await Effect.runPromise(startHealthMonitor(deps))
    // Fiber must keep running after runPromise resolves — wait for at least one tick
    await new Promise((r) => setTimeout(r, 200))
    expect(checkCount).toBeGreaterThanOrEqual(1)
  })

  test("unrecoverable error skips restart and fails immediately", async () => {
    const task = makeTask()
    const failFn = mock(() => Effect.void)
    const restartFn = mock(() => Effect.void)
    const deps = makeDeps({
      checkAgentAlive: () => Effect.succeed(false),
      restartAgent: restartFn,
      failTask: failFn,
      getLastAgentError: () => "Model not found: opencode/gpt-5.4.",
    })
    const result = await Effect.runPromise(checkTask(task, deps))
    expect(result).toBe("failed")
    expect(restartFn).toHaveBeenCalledTimes(0)
    expect(failFn).toHaveBeenCalledTimes(1)
    const failReason = (failFn.mock.calls[0] as unknown as [string, string])[1]
    expect(failReason).toContain("Model not found")
  })

  test("agent error is included in failure message after max restarts", async () => {
    const task = makeTask()
    const failFn = mock(() => Effect.void)
    // Always dead, with a recoverable-looking error
    const deps = makeDeps({
      checkAgentAlive: () => Effect.succeed(false),
      failTask: failFn,
      getLastAgentError: () => "Connection reset by peer",
    })
    // Run checkTask 4 times to hit max restarts (3) + 1 to trigger failure
    for (let i = 0; i < 4; i++) {
      await Effect.runPromise(checkTask(task, deps))
    }
    // The 4th call should have failed with the real error
    const lastCall = failFn.mock.calls[failFn.mock.calls.length - 1] as unknown as [string, string]
    expect(lastCall[1]).toContain("Connection reset by peer")
  })

  test("restart failure includes agent error from provider", async () => {
    const task = makeTask()
    const failFn = mock(() => Effect.void)
    const deps = makeDeps({
      checkAgentAlive: () => Effect.succeed(false),
      restartAgent: () => Effect.fail(new Error("Process exited with code 1")),
      failTask: failFn,
      getLastAgentError: () => "ProviderModelNotFoundError",
    })
    await Effect.runPromise(
      checkTask(task, deps).pipe(Effect.catchAll(() => Effect.succeed("failed" as const)))
    )
    // Should use the agent error, not the generic restart error
    const failReason = (failFn.mock.calls[0] as unknown as [string, string])[1]
    expect(failReason).toContain("ProviderModelNotFoundError")
  })

  test("alive agent is always healthy (no stall detection)", async () => {
    // Even with no activity for a long time, alive agent should be healthy
    const task = makeTask({ started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
    const restartFn = mock(() => Effect.void)
    const deps = makeDeps({
      checkAgentAlive: () => Effect.succeed(true),
      restartAgent: restartFn,
    })
    const result = await Effect.runPromise(checkTask(task, deps))
    expect(result).toBe("healthy")
    expect(restartFn).toHaveBeenCalledTimes(0)
  })

  test("alive agent with unrecoverable error fails immediately", async () => {
    // OpenCode server stays alive even after billing/API errors
    const task = makeTask()
    const failFn = mock(() => Effect.void)
    const deps = makeDeps({
      checkAgentAlive: () => Effect.succeed(true),
      failTask: failFn,
      getLastAgentError: () => "Payment Required: {\"detail\":{\"code\":\"deactivated_workspace\"}}",
    })
    const result = await Effect.runPromise(checkTask(task, deps))
    expect(result).toBe("failed")
    expect(failFn).toHaveBeenCalledTimes(1)
    const failReason = (failFn.mock.calls[0] as unknown as [string, string])[1]
    expect(failReason).toContain("Payment Required")
  })

  test("alive agent with recoverable error stays healthy", async () => {
    const task = makeTask()
    const failFn = mock(() => Effect.void)
    const deps = makeDeps({
      checkAgentAlive: () => Effect.succeed(true),
      failTask: failFn,
      getLastAgentError: () => "Connection reset by peer",
    })
    const result = await Effect.runPromise(checkTask(task, deps))
    expect(result).toBe("healthy")
    expect(failFn).toHaveBeenCalledTimes(0)
  })
})
