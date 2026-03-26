import { describe, expect, test } from "bun:test"
import { mapClaudeCodeEvent } from "../agent/ndjson"

describe("mapClaudeCodeEvent", () => {
  describe("assistant events", () => {
    test("emits per-turn text as narration (not assistant)", () => {
      const events = mapClaudeCodeEvent({
        type: "assistant",
        message: {
          id: "msg_123",
          content: [{ type: "text", text: "Here is my response" }],
        },
      })

      const complete = events.find((e) => e.kind === "message.complete")
      expect(complete).toBeDefined()
      expect(complete).toMatchObject({
        kind: "message.complete",
        role: "narration",
        content: "Here is my response",
        messageId: "msg_123",
      })

      const streaming = events.find((e) => e.kind === "message.streaming")
      expect(streaming).toBeUndefined()
    })

    test("concatenates multiple text blocks into one narration", () => {
      const events = mapClaudeCodeEvent({
        type: "assistant",
        message: {
          id: "msg_456",
          content: [
            { type: "text", text: "Part one. " },
            { type: "text", text: "Part two." },
          ],
        },
      })

      const complete = events.find((e) => e.kind === "message.complete")
      expect(complete).toMatchObject({
        kind: "message.complete",
        role: "narration",
        content: "Part one. Part two.",
      })
    })

    test("emits thinking and tool.start alongside narration", () => {
      const events = mapClaudeCodeEvent({
        type: "assistant",
        message: {
          id: "msg_789",
          content: [
            { type: "thinking", thinking: "Let me think..." },
            { type: "text", text: "I will edit the file" },
            { type: "tool_use", name: "Edit", input: { file: "foo.ts" } },
          ],
        },
      })

      expect(events.find((e) => e.kind === "thinking")).toBeDefined()
      expect(events.find((e) => e.kind === "tool.start")).toMatchObject({
        kind: "tool.start",
        toolName: "Edit",
      })
      expect(events.find((e) => e.kind === "message.complete")).toMatchObject({
        kind: "message.complete",
        role: "narration",
        content: "I will edit the file",
      })
      expect(events.find((e) => e.kind === "status")).toMatchObject({
        kind: "status",
        status: "working",
      })
    })

    test("does not emit message.complete for tool-only messages", () => {
      const events = mapClaudeCodeEvent({
        type: "assistant",
        message: {
          id: "msg_tool",
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      })

      expect(events.find((e) => e.kind === "message.complete")).toBeUndefined()
      expect(events.find((e) => e.kind === "tool.start")).toBeDefined()
    })
  })

  describe("result events", () => {
    test("emits message.complete for non-empty result", () => {
      const events = mapClaudeCodeEvent({
        type: "result",
        result: "Task completed successfully",
        session_id: "sess_1",
      })

      expect(events).toEqual([{
        kind: "message.complete",
        role: "assistant",
        content: "Task completed successfully",
        messageId: "sess_1",
      }])
    })

    test("skips message.complete for empty result", () => {
      const events = mapClaudeCodeEvent({
        type: "result",
        result: "",
      })

      expect(events).toEqual([])
    })

    test("skips message.complete when result is not a string", () => {
      const events = mapClaudeCodeEvent({
        type: "result",
      })

      expect(events).toEqual([])
    })

    test("emits error for error results", () => {
      const events = mapClaudeCodeEvent({
        type: "result",
        subtype: "error",
        result: "Something went wrong",
      })

      expect(events).toEqual([{
        kind: "error",
        message: "Something went wrong",
      }])
    })
  })
})
