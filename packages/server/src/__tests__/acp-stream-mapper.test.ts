import { describe, expect, test } from "bun:test"
import { createAcpStreamMapper, mapAgentEventToStream } from "../agent/acp-stream-mapper"
import type { AgentEvent } from "../agent/provider"

describe("ACP stream mapper", () => {
  test("maps first message chunk to chunk.start", () => {
    const mapper = createAcpStreamMapper()
    const events = mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "chunk.start",
      chunkIndex: 0,
      chunkType: "message",
      content: "Hello",
    })
    expect(events[0]).toHaveProperty("messageId")
  })

  test("maps consecutive message chunks to chunk.delta", () => {
    const mapper = createAcpStreamMapper()

    const first = mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: "Hello",
    })
    const second = mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: " world",
    })

    expect(first[0]?.type).toBe("chunk.start")
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({
      type: "chunk.delta",
      chunkIndex: 0,
      content: " world",
    })
  })

  test("creates new chunk when type changes from message to thought", () => {
    const mapper = createAcpStreamMapper()

    mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: "Hello",
    })
    const thought = mapper.mapSessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: "Thinking...",
    })

    expect(thought).toHaveLength(1)
    expect(thought[0]).toMatchObject({
      type: "chunk.start",
      chunkIndex: 1,
      chunkType: "thought",
      content: "Thinking...",
    })
  })

  test("creates new chunk when type changes from thought to message", () => {
    const mapper = createAcpStreamMapper()

    mapper.mapSessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: "Thinking...",
    })
    const message = mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: "Result",
    })

    expect(message).toHaveLength(1)
    expect(message[0]).toMatchObject({
      type: "chunk.start",
      chunkIndex: 1,
      chunkType: "message",
      content: "Result",
    })
  })

  test("finishMessage emits assistant.done and resets state", () => {
    const mapper = createAcpStreamMapper()

    const start = mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: "Hello",
    })
    const messageId = (start[0] as { messageId: string }).messageId

    const done = mapper.finishMessage()
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({
      type: "assistant.done",
      messageId,
    })

    // New message should start fresh
    const newStart = mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: "New message",
    })
    expect(newStart[0]).toMatchObject({
      type: "chunk.start",
      chunkIndex: 0,
    })
    expect((newStart[0] as { messageId: string }).messageId).not.toBe(messageId)
  })

  test("maps tool_call to tool_call.start", () => {
    const mapper = createAcpStreamMapper()
    const events = mapper.mapSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-123",
      title: "Read",
      rawInput: { file: "test.ts" },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool_call.start",
      toolCallId: "tc-123",
      toolName: "Read",
      input: { file: "test.ts" },
    })
  })

  test("maps tool_call_update with completed status", () => {
    const mapper = createAcpStreamMapper()
    const events = mapper.mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-123",
      status: "completed",
      rawOutput: "file contents",
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool_call.update",
      toolCallId: "tc-123",
      status: "done",
      result: "file contents",
    })
  })

  test("maps tool_call_update with failed status", () => {
    const mapper = createAcpStreamMapper()
    const events = mapper.mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-123",
      status: "failed",
      rawOutput: "error message",
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool_call.update",
      toolCallId: "tc-123",
      status: "error",
      result: "error message",
    })
  })

  test("maps user_message_chunk", () => {
    const mapper = createAcpStreamMapper()
    const events = mapper.mapSessionUpdate({
      sessionUpdate: "user_message_chunk",
      messageId: "user-123",
      content: "User input",
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "user.message",
      id: "user-123",
      content: "User input",
    })
  })

  test("maps plan", () => {
    const mapper = createAcpStreamMapper()
    const events = mapper.mapSessionUpdate({
      sessionUpdate: "plan",
      entries: [
        { id: "1", content: "Step 1", status: "done" },
        { id: "2", content: "Step 2", status: "in_progress" },
        { id: "3", content: "Step 3" },
      ],
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "plan",
      entries: [
        { id: "1", title: "Step 1", status: "done" },
        { id: "2", title: "Step 2", status: "in_progress" },
        { id: "3", title: "Step 3", status: "pending" },
      ],
    })
  })

  test("maps usage_update", () => {
    const mapper = createAcpStreamMapper()
    const events = mapper.mapSessionUpdate({
      sessionUpdate: "usage_update",
      used: 5000,
      size: 200000,
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "usage",
      contextTokens: 5000,
      contextWindowMax: 200000,
    })
  })

  test("handles empty/unknown updates gracefully", () => {
    const mapper = createAcpStreamMapper()

    expect(mapper.mapSessionUpdate({})).toEqual([])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "unknown" })).toEqual([])
    expect(mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: "",
    })).toEqual([])
  })
})

describe("mapAgentEventToStream", () => {
  test("maps message.streaming to chunk events", () => {
    const mapper = createAcpStreamMapper()
    const event: AgentEvent = {
      kind: "message.streaming",
      content: "Hello",
      messageId: "msg-1",
    }

    const events = mapAgentEventToStream(event, mapper)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "chunk.start",
      chunkType: "message",
      content: "Hello",
    })
  })

  test("maps thinking.streaming to thought chunk", () => {
    const mapper = createAcpStreamMapper()
    const event: AgentEvent = {
      kind: "thinking.streaming",
      content: "Thinking...",
      messageId: "thought-1",
    }

    const events = mapAgentEventToStream(event, mapper)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "chunk.start",
      chunkType: "thought",
      content: "Thinking...",
    })
  })

  test("maps message.complete for assistant to assistant.done", () => {
    const mapper = createAcpStreamMapper()

    // First start a message
    mapAgentEventToStream({ kind: "message.streaming", content: "Hello" }, mapper)

    // Then complete it
    const event: AgentEvent = {
      kind: "message.complete",
      role: "assistant",
      content: "Hello world",
      messageId: "msg-1",
    }

    const events = mapAgentEventToStream(event, mapper)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("assistant.done")
  })

  test("maps message.complete for user to user.message", () => {
    const mapper = createAcpStreamMapper()
    const event: AgentEvent = {
      kind: "message.complete",
      role: "user",
      content: "User input",
      messageId: "user-1",
    }

    const events = mapAgentEventToStream(event, mapper)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "user.message",
      id: "user-1",
      content: "User input",
    })
  })

  test("maps tool.start", () => {
    const mapper = createAcpStreamMapper()
    const event: AgentEvent = {
      kind: "tool.start",
      toolCallId: "tc-1",
      toolName: "Read",
      toolInput: '{"file":"test.ts"}',
    }

    const events = mapAgentEventToStream(event, mapper)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool_call.start",
      toolCallId: "tc-1",
      toolName: "Read",
      input: { file: "test.ts" },
    })
  })

  test("maps tool.end", () => {
    const mapper = createAcpStreamMapper()
    const event: AgentEvent = {
      kind: "tool.end",
      toolCallId: "tc-1",
      toolName: "Read",
      toolResult: "file contents",
      status: "success",
    }

    const events = mapAgentEventToStream(event, mapper)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool_call.update",
      toolCallId: "tc-1",
      status: "done",
      result: "file contents",
    })
  })

  test("maps plan", () => {
    const mapper = createAcpStreamMapper()
    const event: AgentEvent = {
      kind: "plan",
      entries: [
        { content: "Step 1", status: "done" },
        { content: "Step 2", status: "in_progress" },
      ],
    }

    const events = mapAgentEventToStream(event, mapper)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("plan")
    expect((events[0] as { entries: unknown[] }).entries).toHaveLength(2)
  })

  test("maps usage", () => {
    const mapper = createAcpStreamMapper()
    const event: AgentEvent = {
      kind: "usage",
      contextTokens: 5000,
      contextWindowMax: 200000,
    }

    const events = mapAgentEventToStream(event, mapper)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "usage",
      contextTokens: 5000,
      contextWindowMax: 200000,
    })
  })
})
