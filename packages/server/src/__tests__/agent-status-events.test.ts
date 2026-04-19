import { describe, it, expect, beforeEach } from "bun:test"
import { setAgentWorkingState, getAgentWorkingState, onAgentStatusChange, clearAgentWorkingState } from "../tasks/events"

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
