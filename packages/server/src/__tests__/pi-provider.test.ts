import { describe, expect, test } from "bun:test"
import { createPiEventMapper } from "../agent/pi-provider"

describe("createPiEventMapper", () => {
  test("does not promote tool results into assistant messages", () => {
    const mapEvent = createPiEventMapper()

    expect(mapEvent({
      type: "message_end",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "raw shell output" }],
      },
    })).toEqual([])
  })

  test("keeps assistant tool-call turns as narration", () => {
    const mapEvent = createPiEventMapper()

    expect(mapEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Inspecting files." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "pwd" } },
        ],
      },
    })).toEqual([{
      kind: "message.complete",
      role: "narration",
      content: "Inspecting files.",
    }])
  })
})
