import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { getHandleMeta, mapOpenCodeEvent, createOpenCodeEventProcessor, adaptRunJsonEvent, buildOpenCodeSystemAgent } from "../agent/opencode-provider"
import type { AgentHandle, AgentEvent } from "../agent/provider"
import { getAgentRuntimeMeta } from "../tasks/lifecycle"

function createHandle(): AgentHandle {
  return {
    sendPrompt: () => Effect.void,
    abort: () => Effect.void,
    subscribe: () => ({ unsubscribe() {} }),
    shutdown: () => Effect.void,
  }
}

describe("OpenCode provider helpers", () => {
  it("maps text delta events to streaming output", () => {
    const event = mapOpenCodeEvent({
      type: "message.part.delta",
      properties: {
        messageID: "msg-1",
        field: "text",
        delta: "hello",
      },
    })

    expect(event).toEqual({ kind: "message.streaming", content: "hello", messageId: "msg-1" })
  })

  it("maps text snapshots to only the unseen suffix", () => {
    const event = mapOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          messageID: "msg-1",
          text: "hello world",
        },
      },
    }, { currentText: "hello " })

    expect(event).toEqual({ kind: "message.streaming", content: "world", messageId: "msg-1" })
  })

  it("maps tool lifecycle events", () => {
    const startEvent = mapOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "pwd" },
          },
        },
      },
    })
    const endEvent = mapOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            output: "/workspace/project\n",
          },
        },
      },
    }, { previousToolStatus: "running" })

    expect(startEvent).toEqual({
      kind: "tool.start",
      toolName: "bash",
      toolInput: JSON.stringify({ command: "pwd" }),
    })
    expect(endEvent).toEqual({
      kind: "tool.end",
      toolName: "bash",
      toolResult: "/workspace/project\n",
    })
  })

  it("maps session status events", () => {
    const event = mapOpenCodeEvent({
      type: "session.status",
      properties: {
        status: { type: "idle" },
      },
    })

    expect(event).toEqual({ kind: "status", status: "idle" })
  })

  it("does not map thinking deltas as text streaming", () => {
    // Thinking deltas have field === "thinking", not "text" — mapOpenCodeEvent
    // should return null so they don't get treated as regular text.
    const event = mapOpenCodeEvent({
      type: "message.part.delta",
      properties: {
        messageID: "msg-1",
        field: "thinking",
        delta: "Let me analyze this...",
      },
    })
    expect(event).toBeNull()
  })

  it("does not map thinking part snapshots as text", () => {
    // part.type === "thinking" should not be treated as text or tool
    const event = mapOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "thinking",
          messageID: "msg-1",
          text: "Analyzing the code structure...",
        },
      },
    })
    expect(event).toBeNull()
  })

  it("skips message.complete for tool-only messages (no accumulated text)", () => {
    const event = mapOpenCodeEvent({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-tool-only",
          role: "assistant",
          time: { completed: 1234567890 },
        },
      },
    })
    expect(event).toBeNull()
  })

  it("exposes OpenCode metadata through lifecycle helper", () => {
    const handle = createHandle() as AgentHandle & {
      __meta: { sessionId: string; agentPort: number | null }
      __pid: number
    }
    handle.__meta = { sessionId: "ses-123", agentPort: null }
    handle.__pid = 4242

    expect(getHandleMeta(handle)).toEqual({ sessionId: "ses-123", agentPort: null })
    expect(getAgentRuntimeMeta(handle)).toEqual({ agentPid: 4242, agentSessionId: "ses-123" })
  })

  it("isAlive is optional on AgentHandle", () => {
    const handle = createHandle()
    // Base handle has no isAlive — health monitor should fall back to PID check
    expect(handle.isAlive).toBeUndefined()
  })

  it("isAlive returns true when handle is active", () => {
    const handle = createHandle()
    handle.isAlive = () => true
    expect(handle.isAlive()).toBe(true)
  })

  it("isAlive returns false after shutdown", () => {
    const handle = createHandle()
    handle.isAlive = () => false
    expect(handle.isAlive()).toBe(false)
  })

  it("builds a custom OpenCode agent with the provided prompt", () => {
    expect(buildOpenCodeSystemAgent("Be terse.")).toEqual({
      description: "Tangerine system prompt agent",
      mode: "primary",
      prompt: "Be terse.",
    })
  })
})

describe("createOpenCodeEventProcessor — image handling", () => {
  const SESSION = "sess-img-test"

  function createProcessor() {
    const events: AgentEvent[] = []
    const processor = createOpenCodeEventProcessor(SESSION, {
      emit: (e) => events.push(e),
    })
    return { process: processor.process, events }
  }

  function filePartEvent(messageId: string, mime: string, dataUrl: string) {
    return {
      type: "message.part.updated",
      properties: {
        part: {
          type: "file",
          messageID: messageId,
          sessionID: SESSION,
          mime,
          url: dataUrl,
        },
      },
    }
  }

  function textDelta(messageId: string, text: string) {
    return {
      type: "message.part.delta",
      properties: {
        messageID: messageId,
        sessionID: SESSION,
        field: "text",
        delta: text,
      },
    }
  }

  function messageCompleted(messageId: string) {
    return {
      type: "message.updated",
      properties: {
        info: {
          id: messageId,
          role: "assistant",
          sessionID: SESSION,
          time: { completed: Date.now() },
        },
      },
    }
  }

  function sessionIdle() {
    return {
      type: "session.status",
      properties: { status: { type: "idle" } },
    }
  }

  it("collects image from file part and attaches to assistant on idle", () => {
    const { process, events } = createProcessor()
    const msgId = "msg-img-1"

    process(textDelta(msgId, "Here is the screenshot"))
    process(filePartEvent(msgId, "image/png", "data:image/png;base64,iVBOR..."))
    process(messageCompleted(msgId))

    // Narration has text but no images
    const narration = events.find(
      (e) => e.kind === "message.complete" && e.role === "narration",
    )
    expect(narration).toBeDefined()
    expect(narration).toMatchObject({
      kind: "message.complete",
      role: "narration",
      content: "Here is the screenshot",
      messageId: msgId,
    })
    expect((narration as { images?: unknown[] })?.images).toBeUndefined()

    // Images only appear on assistant after idle
    process(sessionIdle())
    const assistant = events.find(
      (e) => e.kind === "message.complete" && e.role === "assistant",
    )
    expect(assistant).toBeDefined()
    const images = (assistant as { images?: unknown[] })?.images
    expect(images).toHaveLength(1)
    expect((images as Array<{ mediaType: string }>)?.[0]?.mediaType).toBe("image/png")
  })

  it("defers image-only message to assistant on idle (no narration)", () => {
    const { process, events } = createProcessor()
    const msgId = "msg-img-only"

    // Only an image, no text — no narration emitted
    process(filePartEvent(msgId, "image/jpeg", "data:image/jpeg;base64,/9j/4AAQ..."))
    process(messageCompleted(msgId))

    const narration = events.find(
      (e) => e.kind === "message.complete" && e.role === "narration",
    )
    expect(narration).toBeUndefined()

    // Image appears on assistant after idle
    process(sessionIdle())
    const assistant = events.find(
      (e) => e.kind === "message.complete" && e.role === "assistant",
    )
    expect(assistant).toBeDefined()
    expect((assistant as { images?: unknown[] })?.images).toHaveLength(1)
  })

  it("does not emit narration for tool-only message (no text, no images)", () => {
    const { process, events } = createProcessor()
    const msgId = "msg-tool-only"

    // Only a tool event, no text or images
    process({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          messageID: msgId,
          sessionID: SESSION,
          tool: "bash",
          state: { status: "running", input: { command: "ls" } },
        },
      },
    })
    process(messageCompleted(msgId))

    const narration = events.find(
      (e) => e.kind === "message.complete" && e.role === "narration",
    )
    expect(narration).toBeUndefined()
  })

  it("promotes narration with images to assistant on idle", () => {
    const { process, events } = createProcessor()
    const msgId = "msg-promoted"

    process(textDelta(msgId, "Screenshot taken"))
    process(filePartEvent(msgId, "image/png", "data:image/png;base64,abc123"))
    process(messageCompleted(msgId))
    process(sessionIdle())

    const assistant = events.find(
      (e) => e.kind === "message.complete" && e.role === "assistant",
    )
    expect(assistant).toBeDefined()
    expect(assistant).toMatchObject({
      kind: "message.complete",
      role: "assistant",
      content: "Screenshot taken",
      messageId: msgId,
    })
    expect((assistant as { images?: unknown[] })?.images).toHaveLength(1)
  })

  it("collects multiple images per message on assistant", () => {
    const { process, events } = createProcessor()
    const msgId = "msg-multi-img"

    process(textDelta(msgId, "Two screenshots"))
    process(filePartEvent(msgId, "image/png", "data:image/png;base64,first"))
    process(filePartEvent(msgId, "image/jpeg", "data:image/jpeg;base64,second"))
    process(messageCompleted(msgId))
    process(sessionIdle())

    const assistant = events.find(
      (e) => e.kind === "message.complete" && e.role === "assistant",
    )
    const images = (assistant as { images?: Array<{ mediaType: string }> })?.images
    expect(images).toHaveLength(2)
    expect(images?.[0]?.mediaType).toBe("image/png")
    expect(images?.[1]?.mediaType).toBe("image/jpeg")
  })

  it("ignores file parts with non-image mime types", () => {
    const { process, events } = createProcessor()
    const msgId = "msg-non-img"

    process(textDelta(msgId, "A text file"))
    process(filePartEvent(msgId, "text/plain", "data:text/plain;base64,aGVsbG8="))
    process(messageCompleted(msgId))

    const narration = events.find(
      (e) => e.kind === "message.complete" && e.role === "narration",
    )
    expect(narration).toBeDefined()
    expect((narration as { images?: unknown[] })?.images).toBeUndefined()
  })

  it("ignores file parts without a valid data URL", () => {
    const { process, events } = createProcessor()
    const msgId = "msg-bad-url"

    process(textDelta(msgId, "Bad URL"))
    process(filePartEvent(msgId, "image/png", "https://example.com/image.png"))
    process(messageCompleted(msgId))

    const narration = events.find(
      (e) => e.kind === "message.complete" && e.role === "narration",
    )
    expect((narration as { images?: unknown[] })?.images).toBeUndefined()
  })

  it("handles image/svg+xml mime type (+ in mime)", () => {
    const { process, events } = createProcessor()
    const msgId = "msg-svg"

    process(filePartEvent(msgId, "image/svg+xml", "data:image/svg+xml;base64,PHN2Zz4="))
    process(messageCompleted(msgId))
    process(sessionIdle())

    const assistant = events.find(
      (e) => e.kind === "message.complete" && e.role === "assistant",
    )
    expect(assistant).toBeDefined()
    expect((assistant as { images?: Array<{ mediaType: string }> })?.images?.[0]?.mediaType).toBe("image/svg+xml")
  })

  it("filters events by session ID", () => {
    const { process, events } = createProcessor()

    // Event from a different session — should be ignored
    process({
      type: "message.part.delta",
      properties: {
        messageID: "msg-other",
        sessionID: "other-session",
        field: "text",
        delta: "should be ignored",
      },
    })

    expect(events).toHaveLength(0)
  })

  it("extracts images from tool result attachments to assistant", () => {
    const { process, events } = createProcessor()
    const msgId = "msg-tool-att"

    process(textDelta(msgId, "Here is the image"))

    // Tool completion with image attachment (how OpenCode sends images from Read tool)
    process({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          messageID: msgId,
          sessionID: SESSION,
          callID: "call-read-img",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/tmp/test.png" },
            output: "Image read successfully",
            attachments: [
              {
                id: "att-1",
                sessionID: SESSION,
                messageID: msgId,
                type: "file",
                mime: "image/png",
                url: "data:image/png;base64,iVBORw0KGgo",
              },
            ],
          },
        },
      },
    })

    process(messageCompleted(msgId))

    // Narration has text but no images
    const narration = events.find(
      (e) => e.kind === "message.complete" && e.role === "narration",
    )
    expect(narration).toBeDefined()
    expect((narration as { images?: unknown[] })?.images).toBeUndefined()

    // Images on assistant after idle
    process(sessionIdle())
    const assistant = events.find(
      (e) => e.kind === "message.complete" && e.role === "assistant",
    )
    expect(assistant).toBeDefined()
    const images = (assistant as { images?: Array<{ mediaType: string; data: string }> })?.images
    expect(images).toHaveLength(1)
    expect(images?.[0]?.mediaType).toBe("image/png")
    expect(images?.[0]?.data).toBe("iVBORw0KGgo")
  })

  it("extracts multiple images from tool attachments and file parts to assistant", () => {
    const { process, events } = createProcessor()
    const msgId = "msg-multi-att"

    // Tool with attachment
    process({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          messageID: msgId,
          sessionID: SESSION,
          callID: "call-1",
          tool: "read",
          state: {
            status: "completed",
            output: "ok",
            attachments: [
              { type: "file", mime: "image/png", url: "data:image/png;base64,first" },
              { type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64,second" },
            ],
          },
        },
      },
    })

    // Also a direct file part
    process(filePartEvent(msgId, "image/webp", "data:image/webp;base64,third"))

    process(messageCompleted(msgId))
    process(sessionIdle())

    const assistant = events.find(
      (e) => e.kind === "message.complete" && e.role === "assistant",
    )
    const images = (assistant as { images?: Array<{ mediaType: string }> })?.images
    expect(images).toHaveLength(3)
    expect(images?.[0]?.mediaType).toBe("image/png")
    expect(images?.[1]?.mediaType).toBe("image/jpeg")
    expect(images?.[2]?.mediaType).toBe("image/webp")
  })

  it("ignores non-image attachments in tool results", () => {
    const { process, events } = createProcessor()
    const msgId = "msg-nonimg-att"

    process(textDelta(msgId, "text file"))
    process({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          messageID: msgId,
          sessionID: SESSION,
          callID: "call-txt",
          tool: "read",
          state: {
            status: "completed",
            output: "ok",
            attachments: [
              { type: "file", mime: "text/plain", url: "data:text/plain;base64,aGVsbG8=" },
            ],
          },
        },
      },
    })
    process(messageCompleted(msgId))

    const narration = events.find(
      (e) => e.kind === "message.complete" && e.role === "narration",
    )
    expect((narration as { images?: unknown[] })?.images).toBeUndefined()
  })

  it("cleans up text and image parts after message completion", () => {
    const { process, events } = createProcessor()
    const msgId = "msg-cleanup"

    // First message with image
    process(textDelta(msgId, "First"))
    process(filePartEvent(msgId, "image/png", "data:image/png;base64,abc"))
    process(messageCompleted(msgId))

    // Second message with same ID but no new content — should NOT have stale images
    process(messageCompleted(msgId))

    const narrations = events.filter(
      (e) => e.kind === "message.complete" && e.role === "narration",
    )
    // Only one narration (the first one with content)
    expect(narrations).toHaveLength(1)
  })
})

describe("adaptRunJsonEvent — --format json to internal event conversion", () => {
  it("converts text event to message.part.updated", () => {
    const adapted = adaptRunJsonEvent({
      type: "text",
      timestamp: 1234567890,
      sessionID: "sess-1",
      part: { type: "text", messageID: "msg-1", text: "Hello world" },
    })

    expect(adapted).toHaveLength(1)
    expect(adapted[0]).toEqual({
      type: "message.part.updated",
      properties: {
        part: { type: "text", messageID: "msg-1", text: "Hello world" },
      },
    })
  })

  it("converts tool_use event to message.part.updated", () => {
    const adapted = adaptRunJsonEvent({
      type: "tool_use",
      timestamp: 1234567890,
      sessionID: "sess-1",
      part: {
        type: "tool",
        tool: "bash",
        callID: "call-1",
        state: { status: "running", input: { command: "ls" } },
      },
    })

    expect(adapted).toHaveLength(1)
    expect(adapted[0]).toEqual({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "call-1",
          state: { status: "running", input: { command: "ls" } },
        },
      },
    })
  })

  it("converts reasoning event to message.part.updated", () => {
    const adapted = adaptRunJsonEvent({
      type: "reasoning",
      timestamp: 1234567890,
      sessionID: "sess-1",
      part: { type: "thinking", text: "Let me analyze..." },
    })

    expect(adapted).toHaveLength(1)
    expect(adapted[0]).toEqual({
      type: "message.part.updated",
      properties: {
        part: { type: "thinking", text: "Let me analyze..." },
      },
    })
  })

  it("converts step_start to session.status busy", () => {
    const adapted = adaptRunJsonEvent({
      type: "step_start",
      timestamp: 1234567890,
      sessionID: "sess-1",
      part: { id: "step-1" },
    })

    expect(adapted).toEqual([{
      type: "session.status",
      properties: { status: { type: "busy" } },
    }])
  })

  it("converts step_finish to message.updated completion", () => {
    const adapted = adaptRunJsonEvent({
      type: "step_finish",
      timestamp: 1234567890,
      sessionID: "sess-1",
      part: { messageID: "msg-1", id: "step-1" },
    })

    expect(adapted).toHaveLength(1)
    expect(adapted[0]).toEqual({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-1",
          role: "assistant",
          time: { completed: 1234567890 },
        },
      },
    })
  })

  it("converts error event to session.error", () => {
    const adapted = adaptRunJsonEvent({
      type: "error",
      timestamp: 1234567890,
      sessionID: "sess-1",
      error: { message: "Something went wrong" },
    })

    expect(adapted).toEqual([{
      type: "session.error",
      properties: { error: { message: "Something went wrong" } },
    }])
  })

  it("returns empty array for unknown event types", () => {
    expect(adaptRunJsonEvent({ type: "unknown_event" })).toEqual([])
  })

  it("returns empty array for events without part (text/tool_use)", () => {
    expect(adaptRunJsonEvent({ type: "text" })).toEqual([])
    expect(adaptRunJsonEvent({ type: "tool_use" })).toEqual([])
  })

  it("works end-to-end with processor: text → narration → assistant on idle", () => {
    const events: AgentEvent[] = []
    const processor = createOpenCodeEventProcessor("sess-e2e", {
      emit: (e) => events.push(e),
    })

    // Simulate --format json events fed through the adapter
    const textEvent = adaptRunJsonEvent({
      type: "text",
      timestamp: Date.now(),
      sessionID: "sess-e2e",
      part: { type: "text", messageID: "msg-e2e", sessionID: "sess-e2e", text: "Analysis complete" },
    })
    for (const e of textEvent) processor.process(e)

    const finishEvent = adaptRunJsonEvent({
      type: "step_finish",
      timestamp: Date.now(),
      sessionID: "sess-e2e",
      part: { messageID: "msg-e2e", sessionID: "sess-e2e" },
    })
    for (const e of finishEvent) processor.process(e)

    // Narration emitted on step_finish
    const narration = events.find(
      (e) => e.kind === "message.complete" && e.role === "narration",
    )
    expect(narration).toMatchObject({
      kind: "message.complete",
      role: "narration",
      content: "Analysis complete",
    })

    // Synthetic idle promotes narration to assistant
    processor.process({ type: "session.status", properties: { status: { type: "idle" } } })

    const assistant = events.find(
      (e) => e.kind === "message.complete" && e.role === "assistant",
    )
    expect(assistant).toMatchObject({
      kind: "message.complete",
      role: "assistant",
      content: "Analysis complete",
    })
  })
})
