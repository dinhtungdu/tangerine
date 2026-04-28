import { describe, it, expect, beforeEach } from "bun:test"
import { setAgentWorkingState, getAgentWorkingState, onAgentStatusChange, clearAgentWorkingState, getEffectiveAgentStatus, isAgentStalled, resetIfStalled, recordAgentProgress, AGENT_PROGRESS_TIMEOUT_MS } from "../tasks/events"

describe("agent status events", () => {
  const testTaskId = "agent-status-test-" + Date.now()

  beforeEach(() => {
    clearAgentWorkingState(testTaskId)
  })

  it("broadcasts agent_status changes to global listeners", () => {
    const events: Array<{ taskId: string; agentStatus: "idle" | "working" }> = []
    const unsub = onAgentStatusChange((ev) => events.push(ev))

    setAgentWorkingState(testTaskId, "working")
    setAgentWorkingState(testTaskId, "idle")

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ taskId: testTaskId, agentStatus: "working" })
    expect(events[1]).toEqual({ taskId: testTaskId, agentStatus: "idle" })

    unsub()
  })

  it("unsubscribes correctly", () => {
    const events: Array<{ taskId: string; agentStatus: "idle" | "working" }> = []
    const unsub = onAgentStatusChange((ev) => events.push(ev))

    setAgentWorkingState(testTaskId, "working")
    unsub()
    setAgentWorkingState(testTaskId, "idle")

    expect(events).toHaveLength(1)
    expect(events[0]?.agentStatus).toBe("working")
  })

  it("updates local state correctly", () => {
    expect(getAgentWorkingState(testTaskId)).toBe("idle")
    setAgentWorkingState(testTaskId, "working")
    expect(getAgentWorkingState(testTaskId)).toBe("working")
    setAgentWorkingState(testTaskId, "idle")
    expect(getAgentWorkingState(testTaskId)).toBe("idle")
  })
})

describe("stall detection", () => {
  const taskId = "stall-test-" + Date.now()

  beforeEach(() => {
    clearAgentWorkingState(taskId)
  })

  it("isAgentStalled returns false for idle agent", () => {
    setAgentWorkingState(taskId, "idle")
    expect(isAgentStalled(taskId)).toBe(false)
  })

  it("isAgentStalled returns false for recently started work", () => {
    setAgentWorkingState(taskId, "working")
    expect(isAgentStalled(taskId)).toBe(false)
  })

  it("isAgentStalled returns false for unknown task", () => {
    expect(isAgentStalled("unknown-task")).toBe(false)
  })

  it("resetIfStalled does nothing for non-stalled agent", () => {
    setAgentWorkingState(taskId, "working")
    expect(resetIfStalled(taskId)).toBe(false)
    expect(getAgentWorkingState(taskId)).toBe("working")
  })

  it("getEffectiveAgentStatus returns idle for idle agent", () => {
    setAgentWorkingState(taskId, "idle")
    expect(getEffectiveAgentStatus(taskId)).toBe("idle")
  })

  it("getEffectiveAgentStatus returns working for recently started work", () => {
    setAgentWorkingState(taskId, "working")
    expect(getEffectiveAgentStatus(taskId)).toBe("working")
  })

  it("getEffectiveAgentStatus returns idle for unknown task", () => {
    expect(getEffectiveAgentStatus("unknown-task")).toBe("idle")
  })
})

describe("stall detection with time manipulation", () => {
  const taskId = "stall-time-test"

  beforeEach(() => {
    clearAgentWorkingState(taskId)
  })

  it("detects stall after timeout and resets state", async () => {
    // Set working state
    setAgentWorkingState(taskId, "working")
    expect(isAgentStalled(taskId)).toBe(false)

    // Mock time by manipulating Date.now
    const originalNow = Date.now
    const futureTime = originalNow() + AGENT_PROGRESS_TIMEOUT_MS + 1000
    Date.now = () => futureTime

    try {
      // Now should be stalled
      expect(isAgentStalled(taskId)).toBe(true)

      // resetIfStalled should reset and return true
      expect(resetIfStalled(taskId)).toBe(true)
      expect(getAgentWorkingState(taskId)).toBe("idle")

      // Subsequent calls should return false (already idle)
      expect(isAgentStalled(taskId)).toBe(false)
      expect(resetIfStalled(taskId)).toBe(false)
    } finally {
      Date.now = originalNow
    }
  })

  it("getEffectiveAgentStatus resets stalled agent", async () => {
    setAgentWorkingState(taskId, "working")

    const originalNow = Date.now
    const futureTime = originalNow() + AGENT_PROGRESS_TIMEOUT_MS + 1000
    Date.now = () => futureTime

    try {
      // Should return idle and reset state
      expect(getEffectiveAgentStatus(taskId)).toBe("idle")
      expect(getAgentWorkingState(taskId)).toBe("idle")
    } finally {
      Date.now = originalNow
    }
  })

  it("recordAgentProgress resets stall timer", async () => {
    setAgentWorkingState(taskId, "working")

    const originalNow = Date.now
    let mockTime = originalNow()

    Date.now = () => mockTime

    try {
      // Advance time close to timeout
      mockTime += AGENT_PROGRESS_TIMEOUT_MS - 10_000
      expect(isAgentStalled(taskId)).toBe(false)

      // Record progress - should reset timer
      recordAgentProgress(taskId)

      // Advance time again - should not be stalled because timer was reset
      mockTime += AGENT_PROGRESS_TIMEOUT_MS - 10_000
      expect(isAgentStalled(taskId)).toBe(false)

      // Advance past timeout without progress - now should be stalled
      mockTime += 20_000
      expect(isAgentStalled(taskId)).toBe(true)
    } finally {
      Date.now = originalNow
    }
  })
})
