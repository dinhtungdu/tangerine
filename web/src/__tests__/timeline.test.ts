import { describe, expect, test } from "bun:test"
import type { ActivityEntry } from "@tangerine/shared"
import type { ChatMessage } from "../hooks/useSession"
import {
  buildToolContent,
  deriveChatTimelineGroups,
  deriveStreamingStatusLabel,
  deriveToolStatus,
  splitToolSegments,
} from "../lib/timeline"

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-1",
    role: "assistant",
    content: "message",
    timestamp: "2026-04-18T12:00:00.000Z",
    ...overrides,
  }
}

function activity(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 1,
    taskId: "task-1",
    type: "system",
    event: "tool.read",
    content: "Read",
    metadata: null,
    timestamp: "2026-04-18T12:00:00.000Z",
    ...overrides,
  }
}

describe("timeline derivation", () => {
  test("orders messages and tool activities by timestamp", () => {
    const groups = deriveChatTimelineGroups({
      messages: [
        message({ id: "assistant-1", content: "first", timestamp: "2026-04-18T12:00:00.000Z" }),
        message({ id: "assistant-2", content: "second", timestamp: "2026-04-18T12:00:10.000Z" }),
      ],
      activities: [
        activity({ id: 101, timestamp: "2026-04-18T12:00:03.000Z" }),
      ],
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]!.items.map((item) => item.kind === "message" ? item.data.id : item.data.id)).toEqual([
      "assistant-1",
      101,
      "assistant-2",
    ])
  })

  test("starts a new group at each user message", () => {
    const groups = deriveChatTimelineGroups({
      messages: [
        message({ id: "user-1", role: "user", timestamp: "2026-04-18T12:00:00.000Z" }),
        message({ id: "assistant-1", role: "assistant", timestamp: "2026-04-18T12:00:01.000Z" }),
        message({ id: "user-2", role: "user", timestamp: "2026-04-18T12:00:02.000Z" }),
      ],
      activities: [],
    })

    expect(groups.map((group) => group.id)).toEqual(["msg-user-1", "msg-assistant-1", "msg-user-2"])
  })

  test("summarizes consecutive tool segments only", () => {
    const group = deriveChatTimelineGroups({
      messages: [
        message({ id: "assistant-1", timestamp: "2026-04-18T12:00:00.000Z" }),
        message({ id: "thinking-1", role: "thinking", timestamp: "2026-04-18T12:00:03.000Z" }),
      ],
      activities: [
        activity({ id: 101, event: "tool.write", metadata: { toolName: "Write", toolInput: { file_path: "one.ts" } }, timestamp: "2026-04-18T12:00:01.000Z" }),
        activity({ id: 102, event: "tool.edit", metadata: { toolName: "Edit", toolInput: { file_path: "two.ts" }, status: "error" }, timestamp: "2026-04-18T12:00:02.000Z" }),
        activity({ id: 103, event: "tool.read", timestamp: "2026-04-18T12:00:04.000Z" }),
      ],
    })[0]!

    const segments = splitToolSegments(group.items)

    expect(segments).toHaveLength(4)
    expect(segments[1]!.kind).toBe("tool-segment")
    if (segments[1]!.kind !== "tool-segment") throw new Error("expected tool segment")
    expect(segments[1]!.summary).toMatchObject({ toolCount: 2, filesChanged: 2, errorCount: 1 })
    expect(segments[3]!.kind).toBe("tool")
  })

  test("marks only the latest running tool as running while streaming", () => {
    const first = activity({ id: 101, metadata: { status: "running" } })
    const last = activity({ id: 102, metadata: { status: "running" } })

    expect(deriveToolStatus(first, { isStreaming: true, isLastTool: false })).toBe("success")
    expect(deriveToolStatus(last, { isStreaming: true, isLastTool: true })).toBe("running")
  })

  test("describes the current streaming work from the latest active block", () => {
    const toolGroup = deriveChatTimelineGroups({
      messages: [message({ id: "assistant-1", timestamp: "2026-04-18T12:00:00.000Z" })],
      activities: [
        activity({
          id: 101,
          event: "tool.bash",
          content: "Bash",
          metadata: { toolName: "Bash", toolInput: { command: "bun test" }, status: "running" },
          timestamp: "2026-04-18T12:00:02.000Z",
        }),
      ],
    })[0]!

    expect(deriveStreamingStatusLabel(toolGroup)).toBe("Bash · bun test")

    const thinkingGroup = deriveChatTimelineGroups({
      messages: [message({ id: "thinking-1", role: "thinking", content: "checking", timestamp: "2026-04-18T12:00:00.000Z" })],
      activities: [],
    })[0]!

    expect(deriveStreamingStatusLabel(thinkingGroup)).toBe("Thinking")
  })

  test("builds tool display content from normalized metadata", () => {
    const content = buildToolContent(activity({
      event: "tool.bash",
      metadata: { toolName: "Bash", toolInput: JSON.stringify({ command: "bun test" }), status: "success" },
    }))

    expect(JSON.parse(content)).toMatchObject({
      tool: "Bash",
      name: "Bash",
      input: { command: "bun test" },
      status: "success",
    })
  })
})
