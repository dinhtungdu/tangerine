import { afterEach, describe, expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { createTaskListStreamHandlers, initialTaskStreamMessages } from "../api/routes/ws"
import { clearTaskState, getTaskState } from "../tasks/task-state"
import { clearAgentWorkingState, getAgentWorkingState, setAgentWorkingState } from "../tasks/events"
import type { AgentHandle } from "../agent/provider"

const aliveHandle: AgentHandle = {
  sendPrompt: () => Effect.void,
  abort: () => Effect.void,
  subscribe: () => ({ unsubscribe() {} }),
  shutdown: () => Effect.void,
  isAlive: () => true,
}

const deadHandle: AgentHandle = { ...aliveHandle, isAlive: () => false }

describe("initialTaskStreamMessages", () => {
  const taskId = "ws-route-test-task"

  afterEach(() => {
    clearTaskState(taskId)
    clearAgentWorkingState(taskId)
  })

  test("sends empty slash-command state on reconnect", () => {
    getTaskState(taskId).slashCommands = []

    const messages = initialTaskStreamMessages(taskId, { id: taskId, status: "running" }, () => aliveHandle)

    expect(messages).toContainEqual({
      type: "event",
      data: { event: "slash.commands", commands: [] },
    })
  })

  test("uses effective agent status for reconnect snapshot", () => {
    setAgentWorkingState(taskId, "working")
    const originalNow = Date.now
    Date.now = () => originalNow() + 180_000
    try {
      const messages = initialTaskStreamMessages(taskId, { id: taskId, status: "running" }, () => aliveHandle)

      expect(messages).toContainEqual({ type: "agent_status", agentStatus: "idle" })
      expect(getAgentWorkingState(taskId)).toBe("idle")
    } finally {
      Date.now = originalNow
    }
  })

  test("reports disconnected in reconnect snapshot when handle is dead", () => {
    setAgentWorkingState(taskId, "working")

    const messages = initialTaskStreamMessages(taskId, { id: taskId, status: "running" }, () => deadHandle)

    expect(messages).toContainEqual({ type: "agent_status", agentStatus: "disconnected" })
  })
})

describe("createTaskListStreamHandlers", () => {
  test("starts heartbeat and marks task-list sockets alive on pong", () => {
    const heartbeat = {
      start: mock(() => {}),
      markAlive: mock(() => {}),
      stop: mock(() => {}),
    }
    const handlers = createTaskListStreamHandlers({
      authEnabled: false,
      requestAuthenticated: true,
      authToken: null,
      createHeartbeat: () => heartbeat,
    })
    const socket = {
      send: mock((_data: string) => {}),
      close: mock((_code?: number, _reason?: string) => {}),
    }

    handlers.onOpen(new Event("open"), socket)
    handlers.onMessage({ data: JSON.stringify({ type: "pong" }) }, socket)
    handlers.onClose()

    expect(heartbeat.start).toHaveBeenCalledTimes(1)
    expect(heartbeat.markAlive).toHaveBeenCalledTimes(1)
    expect(heartbeat.stop).toHaveBeenCalledTimes(1)
  })
})
