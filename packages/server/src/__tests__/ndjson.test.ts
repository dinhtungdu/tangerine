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

describe("createClaudeCodeMapper — image buffering", () => {
  const fakeImage = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBOR..." },
  }

  test("buffers images from tool_result and attaches to result (not narration)", () => {
    const mapper = createClaudeCodeMapper()

    // 1. User event with tool_result containing an image
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

    // Should emit tool.end + status, no images yet
    expect(userEvents.find((e) => e.kind === "tool.end")).toBeDefined()
    expect(userEvents.find((e) => e.kind === "message.complete")).toBeUndefined()

    // 2. Next assistant message does NOT get the image (stays buffered)
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
    // Narration should NOT have images
    expect((narration as { images?: unknown[] }).images).toBeUndefined()

    // 3. Result event picks up the buffered image
    const resultEvents = mapper({
      type: "result",
      result: "Here is the screenshot",
      session_id: "sess_1",
    })

    const complete = resultEvents.find((e) => e.kind === "message.complete")
    expect(complete).toBeDefined()
    expect(complete).toMatchObject({ kind: "message.complete", role: "assistant", content: "Here is the screenshot" })
    expect((complete as { images?: unknown[] }).images).toHaveLength(1)
    expect((complete as { images?: Array<{ mediaType: string }> }).images?.[0]?.mediaType).toBe("image/png")
  })

  test("attaches buffered images to result event if no assistant message follows", () => {
    const mapper = createClaudeCodeMapper()

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

    // Result event should pick up the buffered image
    const resultEvents = mapper({
      type: "result",
      result: "Done",
      session_id: "sess_1",
    })

    const complete = resultEvents.find((e) => e.kind === "message.complete")
    expect(complete).toBeDefined()
    expect((complete as { images?: unknown[] }).images).toHaveLength(1)
  })

  test("emits result with images even when result text is empty", () => {
    const mapper = createClaudeCodeMapper()

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

    // Empty result text — should still emit because images are present
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
    expect((resultEvents[0] as { images?: unknown[] }).images).toHaveLength(1)
  })

  test("clears buffered images on error result", () => {
    const mapper = createClaudeCodeMapper()

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

    // Error result should clear buffered images
    const errorEvents = mapper({
      type: "result",
      subtype: "error",
      result: "fail",
    })
    expect(errorEvents).toEqual([{ kind: "error", message: "fail" }])

    // Subsequent assistant should have no images
    const assistantEvents = mapper({
      type: "assistant",
      message: { id: "msg_after_error", content: [{ type: "text", text: "recovered" }] },
    })
    const complete = assistantEvents.find((e) => e.kind === "message.complete")
    expect((complete as { images?: unknown[] }).images).toBeUndefined()
  })

  test("merges tool-result images with assistant-produced images on result", () => {
    const mapper = createClaudeCodeMapper()

    // Buffer an image from tool result
    mapper({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tu_5",
          name: "Read",
          content: [fakeImage],
        }],
      },
    })

    // Assistant event also has an inline image — both should be buffered
    const assistantEvents = mapper({
      type: "assistant",
      message: {
        id: "msg_both",
        content: [
          { type: "text", text: "Two images" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ..." } },
        ],
      },
    })

    // Narration should NOT have images
    const narration = assistantEvents.find((e) => e.kind === "message.complete")
    expect((narration as { images?: unknown[] }).images).toBeUndefined()

    // Result event gets both images
    const resultEvents = mapper({
      type: "result",
      result: "Two images",
      session_id: "sess_1",
    })

    const complete = resultEvents.find((e) => e.kind === "message.complete")
    expect(complete).toMatchObject({ content: "Two images" })
    const images = (complete as { images?: Array<{ mediaType: string }> }).images
    expect(images).toHaveLength(2)
    // Tool-result image first, then inline image
    expect(images?.[0]?.mediaType).toBe("image/png")
    expect(images?.[1]?.mediaType).toBe("image/jpeg")
  })

  test("tool-result images are NOT attached to narration, only to result", () => {
    const mapper = createClaudeCodeMapper()

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

    // No narration emitted (no text, images stay buffered)
    expect(events.find((e) => e.kind === "message.complete")).toBeUndefined()

    // Result gets the buffered image
    const resultEvents = mapper({
      type: "result",
      result: "Done",
    })
    const complete = resultEvents.find((e) => e.kind === "message.complete")
    expect(complete).toBeDefined()
    expect((complete as { images?: unknown[] }).images).toHaveLength(1)
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

  test("emits result with images attached", () => {
    const mapper = createClaudeCodeMapper()
    const fakeImage = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBOR..." },
    }

    // Buffer an image
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

    // Result with images
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
    expect((resultEvents[0] as { images?: unknown[] }).images).toHaveLength(1)
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
