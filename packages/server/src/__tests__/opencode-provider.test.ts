import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { getHandleMeta, mapSseEvent } from "../agent/opencode-provider"
import type { AgentHandle } from "../agent/provider"
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
    const event = mapSseEvent({
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
    const event = mapSseEvent({
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
    const startEvent = mapSseEvent({
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
    const endEvent = mapSseEvent({
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
    const event = mapSseEvent({
      type: "session.status",
      properties: {
        status: { type: "idle" },
      },
    })

    expect(event).toEqual({ kind: "status", status: "idle" })
  })

  it("exposes OpenCode metadata through lifecycle helper", () => {
    const handle = createHandle() as AgentHandle & {
      __meta: { sessionId: string; agentPort: number }
      __pid: number
    }
    handle.__meta = { sessionId: "ses-123", agentPort: 4096 }
    handle.__pid = 4242

    expect(getHandleMeta(handle)).toEqual({ sessionId: "ses-123", agentPort: 4096 })
    expect(getAgentRuntimeMeta(handle)).toEqual({ agentPid: 4242, agentSessionId: "ses-123" })
  })
})
