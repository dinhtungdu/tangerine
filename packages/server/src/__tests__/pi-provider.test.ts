import { describe, expect, test } from "bun:test"
import { createPiEventMapper, extractPiUsage } from "../agent/pi-provider"

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

  test("emits usage from agent_end with usage data", () => {
    const mapEvent = createPiEventMapper()

    const events = mapEvent({
      type: "agent_end",
      usage: { inputTokens: 5000, outputTokens: 1200 },
    })

    expect(events).toContainEqual({ kind: "status", status: "idle" })
    expect(events).toContainEqual({ kind: "usage", inputTokens: 5000, outputTokens: 1200 })
  })

  test("emits usage from turn_end", () => {
    const mapEvent = createPiEventMapper()

    const events = mapEvent({
      type: "turn_end",
      usage: { input_tokens: 3000, output_tokens: 700 },
    })

    expect(events).toEqual([{ kind: "usage", inputTokens: 3000, outputTokens: 700 }])
  })

  test("agent_end without usage emits only status", () => {
    const mapEvent = createPiEventMapper()

    expect(mapEvent({ type: "agent_end" })).toEqual([{ kind: "status", status: "idle" }])
  })
})

describe("extractPiUsage", () => {
  test("extracts camelCase usage fields", () => {
    expect(extractPiUsage({ usage: { inputTokens: 4000, outputTokens: 900 } }))
      .toEqual({ kind: "usage", inputTokens: 4000, outputTokens: 900 })
  })

  test("extracts snake_case usage fields", () => {
    expect(extractPiUsage({ usage: { input_tokens: 3000, output_tokens: 700 } }))
      .toEqual({ kind: "usage", inputTokens: 3000, outputTokens: 700 })
  })

  test("returns null when no usage field", () => {
    expect(extractPiUsage({})).toBeNull()
  })

  test("returns null when all tokens are zero", () => {
    expect(extractPiUsage({ usage: { inputTokens: 0, outputTokens: 0 } })).toBeNull()
  })
})
