import { afterEach, describe, expect, mock, test } from "bun:test"
import { createTaskListStreamHandlers, initialTaskStreamMessages } from "../api/routes/ws"
import { clearTaskState, getTaskState } from "../tasks/task-state"

describe("initialTaskStreamMessages", () => {
  const taskId = "ws-route-test-task"

  afterEach(() => {
    clearTaskState(taskId)
  })

  test("sends empty slash-command state on reconnect", () => {
    getTaskState(taskId).slashCommands = []

    const messages = initialTaskStreamMessages(taskId, { status: "running" })

    expect(messages).toContainEqual({
      type: "event",
      data: { event: "slash.commands", commands: [] },
    })
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
