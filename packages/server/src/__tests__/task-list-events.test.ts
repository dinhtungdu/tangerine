import { describe, expect, it } from "bun:test"
import { emitTaskListChange, onTaskListChange } from "../task-list-events"

describe("task list events", () => {
  it("broadcasts task row changes to global listeners", () => {
    const events: Array<{ taskId: string; change: "created" | "updated" | "deleted" }> = []
    const unsub = onTaskListChange((ev) => events.push(ev))

    emitTaskListChange("task-list-test", "updated")

    expect(events).toEqual([{ taskId: "task-list-test", change: "updated" }])
    unsub()
  })
})
