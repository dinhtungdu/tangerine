import { afterEach, describe, expect, test } from "bun:test"
import { onTaskEvent } from "../tasks/events"
import { resetSessionAutocompleteState } from "../tasks/lifecycle"
import { clearTaskState, getTaskState } from "../tasks/task-state"

describe("resetSessionAutocompleteState", () => {
  const taskId = "session-state-test-task"

  afterEach(() => {
    clearTaskState(taskId)
  })

  test("clears cached slash commands before a new agent session starts", () => {
    getTaskState(taskId).slashCommands = [{ name: "old", description: "Old command" }]
    const events: unknown[] = []
    const unsubscribe = onTaskEvent(taskId, (event) => events.push(event))

    resetSessionAutocompleteState(taskId)
    unsubscribe()

    expect(getTaskState(taskId).slashCommands).toEqual([])
    expect(events).toContainEqual({ event: "slash.commands", commands: [] })
  })
})
