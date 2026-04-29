import { describe, expect, test } from "bun:test"
import { applyStreamEvent } from "@/lib/thread-reducer"
import type { StreamEvent } from "@/types/events"
import type { AssistantEntry, ThreadEntry, ToolCallEntry } from "@/types/thread"

describe("thread-reducer", () => {
  describe("chunk.start", () => {
    test("creates new assistant entry for first chunk", () => {
      const entries: ThreadEntry[] = []
      const toolIndex = new Map<string, number>()
      const event: StreamEvent = {
        type: "chunk.start",
        messageId: "msg-1",
        chunkIndex: 0,
        chunkType: "message",
        content: "Hello",
      }

      const result = applyStreamEvent(entries, event, toolIndex)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        kind: "assistant",
        id: "msg-1",
        chunks: [{ type: "message", content: "Hello" }],
        streaming: true,
      })
    })

    test("adds chunk to existing assistant entry", () => {
      const entries: ThreadEntry[] = [
        {
          kind: "assistant",
          id: "msg-1",
          chunks: [{ type: "message", content: "Hello" }],
          timestamp: "2024-01-01",
          streaming: true,
        },
      ]
      const toolIndex = new Map<string, number>()
      const event: StreamEvent = {
        type: "chunk.start",
        messageId: "msg-1",
        chunkIndex: 1,
        chunkType: "thought",
        content: "Thinking...",
      }

      const result = applyStreamEvent(entries, event, toolIndex)

      expect(result).toHaveLength(1)
      const assistant = result[0] as AssistantEntry
      expect(assistant.chunks).toHaveLength(2)
      expect(assistant.chunks[1]).toEqual({ type: "thought", content: "Thinking..." })
    })
  })

  describe("chunk.delta", () => {
    test("appends content to existing chunk", () => {
      const entries: ThreadEntry[] = [
        {
          kind: "assistant",
          id: "msg-1",
          chunks: [{ type: "message", content: "Hello" }],
          timestamp: "2024-01-01",
          streaming: true,
        },
      ]
      const toolIndex = new Map<string, number>()
      const event: StreamEvent = {
        type: "chunk.delta",
        messageId: "msg-1",
        chunkIndex: 0,
        content: " world",
      }

      const result = applyStreamEvent(entries, event, toolIndex)

      const assistant = result[0] as AssistantEntry
      expect(assistant.chunks[0]?.content).toBe("Hello world")
    })

    test("ignores delta for non-existent message", () => {
      const entries: ThreadEntry[] = []
      const toolIndex = new Map<string, number>()
      const event: StreamEvent = {
        type: "chunk.delta",
        messageId: "msg-1",
        chunkIndex: 0,
        content: "orphan",
      }

      const result = applyStreamEvent(entries, event, toolIndex)

      expect(result).toHaveLength(0)
    })
  })

  describe("assistant.done", () => {
    test("sets streaming to false", () => {
      const entries: ThreadEntry[] = [
        {
          kind: "assistant",
          id: "msg-1",
          chunks: [{ type: "message", content: "Hello" }],
          timestamp: "2024-01-01",
          streaming: true,
        },
      ]
      const toolIndex = new Map<string, number>()
      const event: StreamEvent = {
        type: "assistant.done",
        messageId: "msg-1",
      }

      const result = applyStreamEvent(entries, event, toolIndex)

      const assistant = result[0] as AssistantEntry
      expect(assistant.streaming).toBe(false)
    })
  })

  describe("tool_call.start", () => {
    test("creates new tool call entry", () => {
      const entries: ThreadEntry[] = []
      const toolIndex = new Map<string, number>()
      const event: StreamEvent = {
        type: "tool_call.start",
        toolCallId: "tc-1",
        toolName: "Read",
        input: { file: "test.ts" },
      }

      const result = applyStreamEvent(entries, event, toolIndex)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        kind: "tool_call",
        toolCallId: "tc-1",
        toolName: "Read",
        input: { file: "test.ts" },
        status: "running",
      })
      expect(toolIndex.get("tc-1")).toBe(0)
    })
  })

  describe("tool_call.update", () => {
    test("updates existing tool call", () => {
      const entries: ThreadEntry[] = [
        {
          kind: "tool_call",
          id: "entry-1",
          toolCallId: "tc-1",
          toolName: "Read",
          input: {},
          status: "running",
        },
      ]
      const toolIndex = new Map<string, number>([["tc-1", 0]])
      const event: StreamEvent = {
        type: "tool_call.update",
        toolCallId: "tc-1",
        status: "done",
        result: "file contents",
      }

      const result = applyStreamEvent(entries, event, toolIndex)

      const toolCall = result[0] as ToolCallEntry
      expect(toolCall.status).toBe("done")
      expect(toolCall.result).toBe("file contents")
    })

    test("uses cached index for O(1) lookup", () => {
      const entries: ThreadEntry[] = [
        { kind: "user", id: "u1", content: "hi", timestamp: "" },
        { kind: "user", id: "u2", content: "hi", timestamp: "" },
        {
          kind: "tool_call",
          id: "t1",
          toolCallId: "tc-1",
          toolName: "Read",
          input: {},
          status: "running",
        },
      ]
      const toolIndex = new Map<string, number>([["tc-1", 2]])
      const event: StreamEvent = {
        type: "tool_call.update",
        toolCallId: "tc-1",
        status: "done",
      }

      const result = applyStreamEvent(entries, event, toolIndex)

      const toolCall = result[2] as ToolCallEntry
      expect(toolCall.status).toBe("done")
    })
  })

  describe("user.message", () => {
    test("creates new user entry", () => {
      const entries: ThreadEntry[] = []
      const toolIndex = new Map<string, number>()
      const event: StreamEvent = {
        type: "user.message",
        id: "user-1",
        content: "Hello",
        images: [{ src: "data:image/png;base64,..." }],
      }

      const result = applyStreamEvent(entries, event, toolIndex)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        kind: "user",
        id: "user-1",
        content: "Hello",
        images: [{ src: "data:image/png;base64,..." }],
      })
    })
  })

  describe("plan", () => {
    test("creates new plan entry", () => {
      const entries: ThreadEntry[] = []
      const toolIndex = new Map<string, number>()
      const event: StreamEvent = {
        type: "plan",
        id: "plan-1",
        entries: [
          { id: "1", title: "Step 1", status: "done" },
          { id: "2", title: "Step 2", status: "pending" },
        ],
      }

      const result = applyStreamEvent(entries, event, toolIndex)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        kind: "plan",
        id: "plan-1",
        entries: [
          { id: "1", title: "Step 1", status: "done" },
          { id: "2", title: "Step 2", status: "pending" },
        ],
      })
    })
  })
})
