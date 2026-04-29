// Thread state reducer - applies stream events to entries

import type { StreamEvent } from "@/types/events"
import type { AssistantEntry, ThreadEntry, ToolCallEntry, UserEntry, PlanEntry } from "@/types/thread"

export function applyStreamEvent(
  entries: ThreadEntry[],
  event: StreamEvent,
  toolCallIndex: Map<string, number>
): ThreadEntry[] {
  switch (event.type) {
    case "chunk.start": {
      const idx = entries.findIndex(
        (e) => e.kind === "assistant" && e.id === event.messageId
      )
      if (idx >= 0) {
        const entry = entries[idx] as AssistantEntry
        const updated: AssistantEntry = {
          ...entry,
          chunks: [...entry.chunks, { type: event.chunkType, content: event.content }],
        }
        return replaceAt(entries, idx, updated)
      }
      const newEntry: AssistantEntry = {
        kind: "assistant",
        id: event.messageId,
        chunks: [{ type: event.chunkType, content: event.content }],
        timestamp: new Date().toISOString(),
        streaming: true,
      }
      return [...entries, newEntry]
    }

    case "chunk.delta": {
      const idx = entries.findIndex(
        (e) => e.kind === "assistant" && e.id === event.messageId
      )
      if (idx < 0) return entries
      const entry = entries[idx] as AssistantEntry
      const chunk = entry.chunks[event.chunkIndex]
      if (!chunk) return entries
      const updatedChunks = [...entry.chunks]
      updatedChunks[event.chunkIndex] = {
        ...chunk,
        content: chunk.content + event.content,
      }
      return replaceAt(entries, idx, { ...entry, chunks: updatedChunks })
    }

    case "assistant.done": {
      const idx = entries.findIndex(
        (e) => e.kind === "assistant" && e.id === event.messageId
      )
      if (idx < 0) return entries
      const entry = entries[idx] as AssistantEntry
      return replaceAt(entries, idx, { ...entry, streaming: false })
    }

    case "tool_call.start": {
      const newEntry: ToolCallEntry = {
        kind: "tool_call",
        id: crypto.randomUUID(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        status: "running",
      }
      toolCallIndex.set(event.toolCallId, entries.length)
      return [...entries, newEntry]
    }

    case "tool_call.update": {
      const idx = findToolCall(entries, event.toolCallId, toolCallIndex)
      if (idx < 0) return entries
      const entry = entries[idx] as ToolCallEntry
      return replaceAt(entries, idx, {
        ...entry,
        status: event.status,
        result: event.result,
        permissionRequest: event.permissionRequest,
      })
    }

    case "user.message": {
      const newEntry: UserEntry = {
        kind: "user",
        id: event.id,
        content: event.content,
        timestamp: new Date().toISOString(),
        images: event.images,
      }
      return [...entries, newEntry]
    }

    case "plan": {
      const newEntry: PlanEntry = {
        kind: "plan",
        id: event.id,
        entries: event.entries,
        timestamp: new Date().toISOString(),
      }
      return [...entries, newEntry]
    }

    case "usage":
      // Usage events are handled separately (context window display)
      return entries
  }
}

function replaceAt<T>(arr: T[], idx: number, value: T): T[] {
  const next = [...arr]
  next[idx] = value
  return next
}

function findToolCall(
  entries: ThreadEntry[],
  toolCallId: string,
  index: Map<string, number>
): number {
  const cached = index.get(toolCallId)
  if (cached !== undefined && entries[cached]?.kind === "tool_call") {
    const entry = entries[cached] as ToolCallEntry
    if (entry.toolCallId === toolCallId) return cached
  }
  const idx = entries.findIndex(
    (e) => e.kind === "tool_call" && (e as ToolCallEntry).toolCallId === toolCallId
  )
  if (idx >= 0) index.set(toolCallId, idx)
  return idx
}
