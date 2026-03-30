import { describe, expect, test } from "bun:test"
import { mapClaudeCodeEvent, createClaudeCodeMapper } from "../agent/ndjson"

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

describe("createClaudeCodeMapper — image path tracking", () => {
  const fakeImage = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBOR..." },
  }

  // Helper: emit a Read tool_use so the mapper tracks the file path
  function emitReadToolUse(mapper: ReturnType<typeof createClaudeCodeMapper>, toolUseId: string, filePath: string) {
    mapper({
      type: "assistant",
      message: {
        id: `msg_${toolUseId}`,
        content: [{ type: "tool_use", id: toolUseId, name: "Read", input: { file_path: filePath } }],
      },
    })
  }

  test("tracks image paths from tool_result and attaches to result (not narration)", () => {
    const mapper = createClaudeCodeMapper()

    // 1. Assistant emits Read tool_use — mapper records file path
    emitReadToolUse(mapper, "tu_1", "/workspace/web/screenshot.png")

    // 2. User event with tool_result containing an image
    const userEvents = mapper({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu_1",
          name: "Read",
          content: [
            { type: "text", text: "Screenshot taken" },
            fakeImage,
          ],
        }],
      },
    })

    // Should emit tool.end + status, no image paths yet
    expect(userEvents.find((e) => e.kind === "tool.end")).toBeDefined()
    expect(userEvents.find((e) => e.kind === "message.complete")).toBeUndefined()

    // 3. Next assistant message does NOT get image paths (stays buffered)
    const assistantEvents = mapper({
      type: "assistant",
      message: {
        id: "msg_img",
        content: [{ type: "text", text: "Here is the screenshot" }],
      },
    })

    const narration = assistantEvents.find((e) => e.kind === "message.complete")
    expect(narration).toMatchObject({
      kind: "message.complete",
      role: "narration",
      content: "Here is the screenshot",
    })
    // Narration should NOT have imagePaths
    expect((narration as { imagePaths?: unknown[] }).imagePaths).toBeUndefined()

    // 4. Result event picks up the buffered image path
    const resultEvents = mapper({
      type: "result",
      result: "Here is the screenshot",
      session_id: "sess_1",
    })

    const complete = resultEvents.find((e) => e.kind === "message.complete")
    expect(complete).toBeDefined()
    expect(complete).toMatchObject({ kind: "message.complete", role: "assistant", content: "Here is the screenshot" })
    expect((complete as { imagePaths?: string[] }).imagePaths).toHaveLength(1)
    expect((complete as { imagePaths?: string[] }).imagePaths?.[0]).toBe("/workspace/web/screenshot.png")
  })

  test("attaches buffered image paths to result event if no assistant message follows", () => {
    const mapper = createClaudeCodeMapper()

    emitReadToolUse(mapper, "tu_2", "/workspace/web/page.png")

    // User event with image in tool_result
    mapper({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu_2",
          name: "Read",
          content: [fakeImage],
        }],
      },
    })

    // Result event should pick up the buffered image path
    const resultEvents = mapper({
      type: "result",
      result: "Done",
      session_id: "sess_1",
    })

    const complete = resultEvents.find((e) => e.kind === "message.complete")
    expect(complete).toBeDefined()
    expect((complete as { imagePaths?: string[] }).imagePaths).toHaveLength(1)
  })

  test("emits result with image paths even when result text is empty", () => {
    const mapper = createClaudeCodeMapper()

    emitReadToolUse(mapper, "tu_3", "/workspace/web/empty.png")

    mapper({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu_3",
          name: "Read",
          content: [fakeImage],
        }],
      },
    })

    // Empty result text — should still emit because image paths are present
    const resultEvents = mapper({
      type: "result",
      result: "",
    })

    expect(resultEvents).toHaveLength(1)
    expect(resultEvents[0]).toMatchObject({
      kind: "message.complete",
      role: "assistant",
      content: "",
    })
    expect((resultEvents[0] as { imagePaths?: string[] }).imagePaths).toHaveLength(1)
  })

  test("clears buffered image paths on error result", () => {
    const mapper = createClaudeCodeMapper()

    emitReadToolUse(mapper, "tu_4", "/workspace/web/error.png")

    mapper({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu_4",
          name: "Read",
          content: [fakeImage],
        }],
      },
    })

    // Error result should clear buffered image paths
    const errorEvents = mapper({
      type: "result",
      subtype: "error",
      result: "fail",
    })
    expect(errorEvents).toEqual([{ kind: "error", message: "fail" }])

    // Subsequent result should have no image paths
    const resultEvents = mapper({
      type: "result",
      result: "recovered",
    })
    const complete = resultEvents.find((e) => e.kind === "message.complete")
    expect((complete as { imagePaths?: string[] }).imagePaths).toBeUndefined()
  })

  test("collects multiple image paths from separate tool results", () => {
    const mapper = createClaudeCodeMapper()

    // Two Read tool_use calls
    emitReadToolUse(mapper, "tu_5a", "/workspace/web/first.png")
    emitReadToolUse(mapper, "tu_5b", "/workspace/web/second.png")

    // Two tool results with images
    mapper({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_5a", name: "Read", content: [fakeImage] },
          { type: "tool_result", tool_use_id: "tu_5b", name: "Read", content: [fakeImage] },
        ],
      },
    })

    // Result event gets both image paths
    const resultEvents = mapper({
      type: "result",
      result: "Two images",
      session_id: "sess_1",
    })

    const complete = resultEvents.find((e) => e.kind === "message.complete")
    expect(complete).toMatchObject({ content: "Two images" })
    const paths = (complete as { imagePaths?: string[] }).imagePaths
    expect(paths).toHaveLength(2)
    expect(paths?.[0]).toBe("/workspace/web/first.png")
    expect(paths?.[1]).toBe("/workspace/web/second.png")
  })

  test("image paths are NOT attached to narration, only to result", () => {
    const mapper = createClaudeCodeMapper()

    emitReadToolUse(mapper, "tu_6", "/workspace/web/narration.png")

    mapper({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu_6",
          name: "Read",
          content: [fakeImage],
        }],
      },
    })

    // Assistant with only tool_use (no text) — should NOT emit narration for buffered images
    const events = mapper({
      type: "assistant",
      message: {
        id: "msg_tool_only",
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ],
      },
    })

    // No narration emitted (no text, image paths stay buffered)
    expect(events.find((e) => e.kind === "message.complete")).toBeUndefined()

    // Result gets the buffered image path
    const resultEvents = mapper({
      type: "result",
      result: "Done",
    })
    const complete = resultEvents.find((e) => e.kind === "message.complete")
    expect(complete).toBeDefined()
    expect((complete as { imagePaths?: string[] }).imagePaths).toHaveLength(1)
  })

  test("skips images from tool results without a tracked Read tool_use", () => {
    const mapper = createClaudeCodeMapper()

    // No preceding Read tool_use — tool_use_id won't match anything
    mapper({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu_unknown",
          name: "Bash",
          content: [fakeImage],
        }],
      },
    })

    const resultEvents = mapper({
      type: "result",
      result: "No images",
    })

    const complete = resultEvents.find((e) => e.kind === "message.complete")
    expect((complete as { imagePaths?: string[] }).imagePaths).toBeUndefined()
  })
})

describe("createClaudeCodeMapper — result always emits assistant", () => {
  test("emits assistant even when text matches last narration", () => {
    const mapper = createClaudeCodeMapper()

    // Assistant turn emits narration
    mapper({
      type: "assistant",
      message: { id: "msg_1", content: [{ type: "text", text: "All done" }] },
    })

    // Result with same text — must still emit as "assistant" role
    const resultEvents = mapper({
      type: "result",
      result: "All done",
      session_id: "sess_1",
    })

    expect(resultEvents).toEqual([{
      kind: "message.complete",
      role: "assistant",
      content: "All done",
      messageId: "sess_1",
    }])
  })

  test("emits result with image paths attached", () => {
    const mapper = createClaudeCodeMapper()
    const fakeImage = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBOR..." },
    }

    // Read tool_use to track file path
    mapper({
      type: "assistant",
      message: {
        id: "msg_tu",
        content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/workspace/img.png" } }],
      },
    })

    // Buffer an image path
    mapper({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu_1",
          name: "Read",
          content: [fakeImage],
        }],
      },
    })

    // Narration
    mapper({
      type: "assistant",
      message: { id: "msg_1", content: [{ type: "text", text: "Here is the image" }] },
    })

    // Result with image paths
    const resultEvents = mapper({
      type: "result",
      result: "Here is the image",
    })

    expect(resultEvents).toHaveLength(1)
    expect(resultEvents[0]).toMatchObject({
      kind: "message.complete",
      role: "assistant",
      content: "Here is the image",
    })
    expect((resultEvents[0] as { imagePaths?: string[] }).imagePaths).toHaveLength(1)
  })

  test("skips result with no content and no images", () => {
    const mapper = createClaudeCodeMapper()

    const resultEvents = mapper({
      type: "result",
      result: "",
    })

    expect(resultEvents).toEqual([])
  })
})
