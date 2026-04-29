import { describe, expect, test } from "bun:test"
import { appendActiveStreamMessage, clearTaskState, completeActiveStreamMessage, getActiveStreamMessages } from "../tasks/task-state"

describe("task active stream state", () => {
  test("buffers active assistant chunks under a stable message id", () => {
    const taskId = crypto.randomUUID()
    clearTaskState(taskId)

    const first = appendActiveStreamMessage(taskId, "assistant", "hel", "msg-1")
    const second = appendActiveStreamMessage(taskId, "assistant", "lo")

    expect(first.messageId).toBe("msg-1")
    expect(second).toMatchObject({ role: "assistant", messageId: "msg-1", content: "hello" })
    expect(getActiveStreamMessages(taskId)).toEqual([second])

    const completed = completeActiveStreamMessage(taskId, "assistant")
    expect(completed).toMatchObject({ role: "assistant", messageId: "msg-1", content: "hello" })
    expect(getActiveStreamMessages(taskId)).toEqual([])

    clearTaskState(taskId)
  })

  test("buffers active narration separately from assistant text", () => {
    const taskId = crypto.randomUUID()
    clearTaskState(taskId)

    const assistant = appendActiveStreamMessage(taskId, "assistant", "reply", "msg-1")
    const narration = appendActiveStreamMessage(taskId, "narration", "checking", "note-1")

    expect(getActiveStreamMessages(taskId)).toEqual([narration, assistant])
    expect(completeActiveStreamMessage(taskId, "narration")).toEqual(narration)
    expect(getActiveStreamMessages(taskId)).toEqual([assistant])

    clearTaskState(taskId)
  })

  test("can complete a provisional narration stream as assistant output", () => {
    const taskId = crypto.randomUUID()
    clearTaskState(taskId)

    const narration = appendActiveStreamMessage(taskId, "narration", "final text", "active-1")

    expect(completeActiveStreamMessage(taskId, "assistant", "narration")).toEqual(narration)
    expect(getActiveStreamMessages(taskId)).toEqual([])

    clearTaskState(taskId)
  })
})
