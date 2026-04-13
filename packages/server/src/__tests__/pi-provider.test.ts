import { describe, expect, test } from "bun:test"
import { createPiEventMapper, extractPiMessageUsage } from "../agent/pi-provider"

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

  test("agent_end does not emit usage (avoids double-counting with turn_end)", () => {
    const mapEvent = createPiEventMapper()

    const events = mapEvent({
      type: "agent_end",
      messages: [
        { role: "assistant", usage: { input: 3000, output: 500, cacheRead: 200, cacheWrite: 100 } },
      ],
    })

    expect(events).toEqual([{ kind: "status", status: "idle" }])
  })

  test("emits usage from turn_end message", () => {
    const mapEvent = createPiEventMapper()

    const events = mapEvent({
      type: "turn_end",
      message: { role: "assistant", usage: { input: 3000, output: 700, cacheRead: 0, cacheWrite: 0 } },
      toolResults: [],
    })

    expect(events).toEqual([{ kind: "usage", inputTokens: 3000, outputTokens: 700 }])
  })

  test("agent_end without messages emits only status", () => {
    const mapEvent = createPiEventMapper()

    expect(mapEvent({ type: "agent_end" })).toEqual([{ kind: "status", status: "idle" }])
  })
})

describe("extractPiMessageUsage", () => {
  test("extracts Pi usage fields (input, output, cacheRead, cacheWrite)", () => {
    expect(extractPiMessageUsage({ usage: { input: 4000, output: 900, cacheRead: 500, cacheWrite: 200 } }))
      .toEqual({ kind: "usage", inputTokens: 4700, outputTokens: 900 })
  })

  test("returns null when no usage field", () => {
    expect(extractPiMessageUsage({})).toBeNull()
  })

  test("returns null when all tokens are zero", () => {
    expect(extractPiMessageUsage({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })).toBeNull()
  })
})
