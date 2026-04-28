import { afterEach, describe, expect, test } from "bun:test"
import { initialTaskStreamMessages } from "../api/routes/ws"
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
