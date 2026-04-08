import { describe, test, expect, mock } from "bun:test"
import { Effect } from "effect"
import { checkTask, checkAllTasks, startHealthMonitor, isTaskSuspended, clearSuspended, parseTaskTimestampMs, resetRestartCount } from "../tasks/health"
import type { HealthCheckDeps } from "../tasks/health"
import type { TaskRow } from "../db/types"
import { ORCHESTRATOR_TASK_NAME } from "@tangerine/shared"
import { getTaskState, clearTaskState } from "../tasks/task-state"

function makeTask(overrides?: Partial<TaskRow>): TaskRow {
  return {
    id: "test-task-1",
    project_id: "test-project",
    source: "manual",
    source_id: null,
    source_url: null,
    title: "Test task",
    type: "worker",
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
    capabilities: null,
    ...overrides,
  }
}

function makeDeps(overrides?: Partial<HealthCheckDeps>): HealthCheckDeps {
  return {
    listRunningTasks: () => Effect.succeed([]),
    checkAgentAlive: () => Effect.succeed(true),
    restartAgent: () => Effect.void,
    failTask: () => Effect.void,
    suspendAgent: () => Effect.void,
    getLastAgentError: () => undefined,
    isAgentWorking: () => false,
    logSuspend: () => Effect.void,
    getLastUserMessageTime: () => new Date().toISOString(),
    getLastRunningActivityTime: () => null,
    logHungTool: () => Effect.void,
    abortHungTool: () => Effect.void,
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

  test("alive agent does not reset restart counter (only real activity does)", async () => {
    const taskId = "stability-test-1"
    const task = makeTask({ id: taskId })
    try {
      const state = getTaskState(taskId)
      state.consecutiveRestarts = 2

      const deps = makeDeps({ checkAgentAlive: () => Effect.succeed(true) })
      const result = await Effect.runPromise(checkTask(task, deps))
      expect(result).toBe("healthy")
      // Counter preserved — only resetRestartCount (called on agent idle) clears it
      expect(getTaskState(taskId).consecutiveRestarts).toBe(2)
    } finally {
      clearTaskState(taskId)
    }
  })

  test("agent that keeps dying after restart eventually fails", async () => {
    const taskId = "stability-test-2"
    const task = makeTask({ id: taskId })
    try {
      const failFn = mock(() => Effect.void)
      const restartFn = mock(() => Effect.void)
      const deps = makeDeps({
        checkAgentAlive: () => Effect.succeed(false),
        restartAgent: restartFn,
        failTask: failFn,
      })
      for (let i = 0; i < 4; i++) {
        await Effect.runPromise(checkTask(task, deps))
      }
      expect(restartFn).toHaveBeenCalledTimes(3)
      expect(failFn).toHaveBeenCalledTimes(1)
    } finally {
      clearTaskState(taskId)
    }
  })

  test("resetRestartCount clears the counter", () => {
    const taskId = "stability-test-3"
    try {
      getTaskState(taskId).consecutiveRestarts = 3
      resetRestartCount(taskId)
      expect(getTaskState(taskId).consecutiveRestarts).toBe(0)
    } finally {
      clearTaskState(taskId)
    }
  })
})

describe("idle timeout", () => {
  test("parses bare SQLite timestamps as UTC", () => {
    expect(parseTaskTimestampMs("2026-03-30 04:49:28")).toBe(Date.parse("2026-03-30T04:49:28Z"))
    expect(parseTaskTimestampMs("2026-03-30T04:49:28Z")).toBe(Date.parse("2026-03-30T04:49:28Z"))
  })

  test("idle task agent is suspended after timeout", async () => {
    const task = makeTask({
      started_at: new Date(Date.now() - 700_000).toISOString(),
    })
    const suspendFn = mock(() => Effect.void)
    const deps = makeDeps({
      listRunningTasks: () => Effect.succeed([task]),
      suspendAgent: suspendFn,
      // Last user message was 11 minutes ago (> 10 min timeout)
      getLastUserMessageTime: () => new Date(Date.now() - 660_000).toISOString(),
    })
    await Effect.runPromise(checkAllTasks(deps))
    expect(suspendFn).toHaveBeenCalledTimes(1)
    expect(isTaskSuspended(task.id)).toBe(true)
    clearSuspended(task.id)
  })

  test("active task is not suspended", async () => {
    const task = makeTask({
      started_at: new Date(Date.now() - 60_000).toISOString(),
    })
    const suspendFn = mock(() => Effect.void)
    const deps = makeDeps({
      listRunningTasks: () => Effect.succeed([task]),
      suspendAgent: suspendFn,
      // Last user message was 1 minute ago (< 10 min timeout)
      getLastUserMessageTime: () => new Date(Date.now() - 60_000).toISOString(),
    })
    await Effect.runPromise(checkAllTasks(deps))
    expect(suspendFn).toHaveBeenCalledTimes(0)
    expect(isTaskSuspended(task.id)).toBe(false)
  })

  test("task with no messages idles based on started_at", async () => {
    const task = makeTask({
      started_at: new Date(Date.now() - 700_000).toISOString(),
    })
    const suspendFn = mock(() => Effect.void)
    const deps = makeDeps({
      listRunningTasks: () => Effect.succeed([task]),
      suspendAgent: suspendFn,
      getLastUserMessageTime: () => null,
    })
    await Effect.runPromise(checkAllTasks(deps))
    expect(suspendFn).toHaveBeenCalledTimes(1)
    expect(isTaskSuspended(task.id)).toBe(true)
    clearSuspended(task.id)
  })

  test("suspended task skips restart on next health check", async () => {
    const task = makeTask({
      started_at: new Date(Date.now() - 700_000).toISOString(),
    })
    const restartFn = mock(() => Effect.void)
    const suspendFn = mock(() => Effect.void)
    let aliveCallCount = 0
    const deps = makeDeps({
      listRunningTasks: () => Effect.succeed([task]),
      // First call: alive (so idle check can suspend). After that: dead.
      checkAgentAlive: () => Effect.succeed(aliveCallCount++ === 0),
      restartAgent: restartFn,
      suspendAgent: suspendFn,
      getLastUserMessageTime: () => new Date(Date.now() - 660_000).toISOString(),
    })
    // First pass: agent alive + idle → suspended
    await Effect.runPromise(checkAllTasks(deps))
    expect(isTaskSuspended(task.id)).toBe(true)
    // Second pass: agent is dead but suspended — should NOT restart
    await Effect.runPromise(checkAllTasks(deps))
    expect(restartFn).toHaveBeenCalledTimes(0)
    clearSuspended(task.id)
  })

  test("idle timeout applies to both orchestrator and regular tasks", async () => {
    const orchestrator = makeTask({
      id: "orch-1",
      title: ORCHESTRATOR_TASK_NAME,
      type: "orchestrator",
      started_at: new Date(Date.now() - 700_000).toISOString(),
    })
    const worker = makeTask({
      id: "worker-1",
      title: "Fix bug",
      started_at: new Date(Date.now() - 700_000).toISOString(),
    })
    const suspendFn = mock(() => Effect.void)
    const deps = makeDeps({
      listRunningTasks: () => Effect.succeed([orchestrator, worker]),
      suspendAgent: suspendFn,
      getLastUserMessageTime: () => new Date(Date.now() - 660_000).toISOString(),
    })
    await Effect.runPromise(checkAllTasks(deps))
    expect(suspendFn).toHaveBeenCalledTimes(2)
    clearSuspended("orch-1")
    clearSuspended("worker-1")
  })

  test("working agent is not suspended even if idle", async () => {
    const task = makeTask({
      started_at: new Date(Date.now() - 700_000).toISOString(),
    })
    const suspendFn = mock(() => Effect.void)
    const deps = makeDeps({
      listRunningTasks: () => Effect.succeed([task]),
      suspendAgent: suspendFn,
      // Idle for 11 minutes but agent is actively working
      getLastUserMessageTime: () => new Date(Date.now() - 660_000).toISOString(),
      isAgentWorking: () => true,
    })
    await Effect.runPromise(checkAllTasks(deps))
    expect(suspendFn).toHaveBeenCalledTimes(0)
    expect(isTaskSuspended(task.id)).toBe(false)
  })

  test("opencode tasks are suspended (disk-based session resume via -s flag)", async () => {
    const task = makeTask({
      provider: "opencode",
      started_at: new Date(Date.now() - 700_000).toISOString(),
    })
    const suspendFn = mock(() => Effect.void)
    const deps = makeDeps({
      listRunningTasks: () => Effect.succeed([task]),
      suspendAgent: suspendFn,
      getLastUserMessageTime: () => new Date(Date.now() - 660_000).toISOString(),
    })
    await Effect.runPromise(checkAllTasks(deps))
    expect(suspendFn).toHaveBeenCalledTimes(1)
    expect(isTaskSuspended(task.id)).toBe(true)
    // Clean up
    clearSuspended(task.id)
  })
})

describe("hung tool watchdog", () => {
  test("aborts agent when tool has been running for >5min", async () => {
    const taskId = "hung-tool-test-1"
    const task = makeTask({ id: taskId })
    const abortFn = mock(() => Effect.void)
    const logFn = mock(() => Effect.void)
    const deps = makeDeps({
      listRunningTasks: () => Effect.succeed([task]),
      isAgentWorking: () => true,
      // Last activity is a running tool from 6 minutes ago
      getLastRunningActivityTime: () => new Date(Date.now() - 360_000).toISOString(),
      abortHungTool: abortFn,
      logHungTool: logFn,
    })
    await Effect.runPromise(checkAllTasks(deps))
    expect(abortFn).toHaveBeenCalledTimes(1)
    expect(logFn).toHaveBeenCalledTimes(1)
    clearTaskState(taskId)
  })

  test("does not abort when tool has been running for <5min", async () => {
    const task = makeTask()
    const abortFn = mock(() => Effect.void)
    const deps = makeDeps({
      listRunningTasks: () => Effect.succeed([task]),
      isAgentWorking: () => true,
      // Last activity is a running tool from 2 minutes ago — not yet hung
      getLastRunningActivityTime: () => new Date(Date.now() - 120_000).toISOString(),
      abortHungTool: abortFn,
    })
    await Effect.runPromise(checkAllTasks(deps))
    expect(abortFn).toHaveBeenCalledTimes(0)
  })

  test("does not abort when agent is idle (no tool running)", async () => {
    const task = makeTask()
    const abortFn = mock(() => Effect.void)
    const deps = makeDeps({
      listRunningTasks: () => Effect.succeed([task]),
      isAgentWorking: () => false,
      getLastRunningActivityTime: () => new Date(Date.now() - 360_000).toISOString(),
      abortHungTool: abortFn,
    })
    await Effect.runPromise(checkAllTasks(deps))
    expect(abortFn).toHaveBeenCalledTimes(0)
  })

  test("does not re-abort within cooldown period after hung-tool abort", async () => {
    const taskId = "hung-tool-test-2"
    const task = makeTask({ id: taskId })
    const abortFn = mock(() => Effect.void)
    const deps = makeDeps({
      listRunningTasks: () => Effect.succeed([task]),
      isAgentWorking: () => true,
      getLastRunningActivityTime: () => new Date(Date.now() - 360_000).toISOString(),
      abortHungTool: abortFn,
    })
    // First pass: aborts
    await Effect.runPromise(checkAllTasks(deps))
    expect(abortFn).toHaveBeenCalledTimes(1)
    // Second pass immediately: should be within cooldown, no re-abort
    await Effect.runPromise(checkAllTasks(deps))
    expect(abortFn).toHaveBeenCalledTimes(1)
    clearTaskState(taskId)
  })

  test("resetRestartCount clears hung-tool cooldown", () => {
    const taskId = "hung-tool-test-3"
    try {
      const state = getTaskState(taskId)
      state.hungToolAbortedAt = Date.now()
      resetRestartCount(taskId)
      expect(getTaskState(taskId).hungToolAbortedAt).toBeUndefined()
    } finally {
      clearTaskState(taskId)
    }
  })

  test("no abort when last activity is not a running tool", async () => {
    const task = makeTask()
    const abortFn = mock(() => Effect.void)
    const deps = makeDeps({
      listRunningTasks: () => Effect.succeed([task]),
      isAgentWorking: () => true,
      // Returns null — last activity is not a running tool (e.g. completed tool)
      getLastRunningActivityTime: () => null,
      abortHungTool: abortFn,
    })
    await Effect.runPromise(checkAllTasks(deps))
    expect(abortFn).toHaveBeenCalledTimes(0)
  })
})
