// ACP to StreamEvent mapper - direct mapping without buffering
// Based on Zed's handle_session_update pattern

import type { PermissionOption } from "./acp-provider"
import type { AgentEvent } from "./provider"

export type StreamEvent =
  | ChunkStartEvent
  | ChunkDeltaEvent
  | AssistantDoneEvent
  | ToolCallStartEvent
  | ToolCallUpdateEvent
  | UserMessageEvent
  | PlanEvent
  | UsageEvent

export interface ChunkStartEvent {
  type: "chunk.start"
  messageId: string
  chunkIndex: number
  chunkType: "message" | "thought"
  content: string
}

export interface ChunkDeltaEvent {
  type: "chunk.delta"
  messageId: string
  chunkIndex: number
  content: string
}

export interface AssistantDoneEvent {
  type: "assistant.done"
  messageId: string
}

export interface ToolCallStartEvent {
  type: "tool_call.start"
  toolCallId: string
  toolName: string
  input: unknown
}

export interface ToolCallUpdateEvent {
  type: "tool_call.update"
  toolCallId: string
  status: "pending_permission" | "running" | "done" | "error"
  result?: string
  permissionRequest?: {
    requestId: string
    options: Array<{ id: string; name: string; description?: string }>
  }
}

export interface UserMessageEvent {
  type: "user.message"
  id: string
  content: string
}

export interface PlanEvent {
  type: "plan"
  id: string
  entries: Array<{ id: string; title: string; status: "pending" | "in_progress" | "done" }>
}

export interface UsageEvent {
  type: "usage"
  contextTokens?: number
  contextWindowMax?: number
}

export interface StreamState {
  messageId: string | null
  chunkIndex: number
  lastChunkType: "message" | "thought" | null
}

export function createStreamState(): StreamState {
  return {
    messageId: null,
    chunkIndex: -1,
    lastChunkType: null,
  }
}

export function createAcpStreamMapper() {
  const state: StreamState = createStreamState()
  let planSequence = 0

  function pushChunk(
    chunkType: "message" | "thought",
    text: string
  ): StreamEvent[] {
    if (!text) return []

    // First chunk of new message
    if (!state.messageId) {
      state.messageId = crypto.randomUUID()
      state.chunkIndex = 0
      state.lastChunkType = chunkType
      return [{
        type: "chunk.start",
        messageId: state.messageId,
        chunkIndex: 0,
        chunkType,
        content: text,
      }]
    }

    // Same type → delta to existing chunk
    if (state.lastChunkType === chunkType) {
      return [{
        type: "chunk.delta",
        messageId: state.messageId,
        chunkIndex: state.chunkIndex,
        content: text,
      }]
    }

    // Type changed → new chunk
    state.chunkIndex++
    state.lastChunkType = chunkType
    return [{
      type: "chunk.start",
      messageId: state.messageId,
      chunkIndex: state.chunkIndex,
      chunkType,
      content: text,
    }]
  }

  function finishMessage(): StreamEvent[] {
    if (!state.messageId) return []
    const events: StreamEvent[] = [{
      type: "assistant.done",
      messageId: state.messageId,
    }]
    state.messageId = null
    state.chunkIndex = -1
    state.lastChunkType = null
    return events
  }

  return {
    mapSessionUpdate(update: Record<string, unknown>): StreamEvent[] {
      const kind = update.sessionUpdate as string | undefined
      if (!kind) return []

      switch (kind) {
        case "agent_message_chunk": {
          const text = textFromContent(update.content)
          return text ? pushChunk("message", text) : []
        }

        case "agent_thought_chunk": {
          const text = textFromContent(update.content)
          return text ? pushChunk("thought", text) : []
        }

        case "user_message_chunk": {
          const text = textFromContent(update.content)
          if (!text) return []
          return [{
            type: "user.message",
            id: (update.messageId as string) ?? crypto.randomUUID(),
            content: text,
          }]
        }

        case "tool_call": {
          const toolCallId = update.toolCallId as string ?? crypto.randomUUID()
          const toolName = (update.title as string) ?? (update.kind as string) ?? "tool"
          return [{
            type: "tool_call.start",
            toolCallId,
            toolName,
            input: update.rawInput,
          }]
        }

        case "tool_call_update": {
          const toolCallId = update.toolCallId as string
          if (!toolCallId) return []

          const rawStatus = update.status as string | undefined
          const status = mapToolStatus(rawStatus)
          const result = stringifyToolResult(update.rawOutput, update.content)
          const permissionRequest = mapPermissionRequest(update)

          return [{
            type: "tool_call.update",
            toolCallId,
            status,
            ...(result ? { result } : {}),
            ...(permissionRequest ? { permissionRequest } : {}),
          }]
        }

        case "plan": {
          const entries = parsePlanEntries(update.entries)
          if (entries.length === 0) return []
          return [{
            type: "plan",
            id: `plan-${++planSequence}`,
            entries,
          }]
        }

        case "usage_update": {
          const used = update.used as number | undefined
          const size = update.size as number | undefined
          if (!used && !size) return []
          return [{
            type: "usage",
            ...(used ? { contextTokens: used } : {}),
            ...(size ? { contextWindowMax: size } : {}),
          }]
        }

        default:
          return []
      }
    },

    finishMessage,

    getState(): StreamState {
      return { ...state }
    },

    reset(): void {
      state.messageId = null
      state.chunkIndex = -1
      state.lastChunkType = null
    },
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block
        if (typeof block === "object" && block !== null && "text" in block) {
          return (block as { text: string }).text
        }
        return ""
      })
      .join("")
  }
  if (typeof content === "object" && content !== null && "text" in content) {
    return (content as { text: string }).text
  }
  return ""
}

function mapToolStatus(status: string | undefined): ToolCallUpdateEvent["status"] {
  switch (status) {
    case "pending":
    case "in_progress":
      return "running"
    case "completed":
      return "done"
    case "failed":
      return "error"
    case "pending_permission":
      return "pending_permission"
    default:
      return "running"
  }
}

function stringifyToolResult(rawOutput: unknown, content: unknown): string | undefined {
  if (rawOutput !== undefined && rawOutput !== null) {
    return typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput)
  }
  if (content !== undefined && content !== null) {
    const text = textFromContent(content)
    if (text) return text
    return JSON.stringify(content)
  }
  return undefined
}

function mapPermissionRequest(update: Record<string, unknown>): ToolCallUpdateEvent["permissionRequest"] | undefined {
  const request = update.permissionRequest as Record<string, unknown> | undefined
  if (!request) return undefined

  const requestId = request.requestId as string | undefined
  const options = request.options as PermissionOption[] | undefined
  if (!requestId || !options) return undefined

  return {
    requestId,
    options: options.map((opt) => ({
      id: opt.optionId,
      name: opt.name,
      description: opt.kind,
    })),
  }
}

function parsePlanEntries(entries: unknown): PlanEvent["entries"] {
  if (!Array.isArray(entries)) return []
  return entries
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e, idx) => ({
      id: (e.id as string) ?? `plan-item-${idx}`,
      title: (e.content as string) ?? (e.title as string) ?? "",
      status: mapPlanStatus(e.status as string | undefined),
    }))
    .filter((e) => e.title.length > 0)
}

function mapPlanStatus(status: string | undefined): "pending" | "in_progress" | "done" {
  switch (status) {
    case "in_progress":
      return "in_progress"
    case "done":
    case "completed":
      return "done"
    default:
      return "pending"
  }
}

// Map AgentEvent (from provider.ts) to StreamEvent
// Used by start.ts to emit v2 events alongside v1 events
export function mapAgentEventToStream(
  event: AgentEvent,
  mapper: ReturnType<typeof createAcpStreamMapper>
): StreamEvent[] {
  switch (event.kind) {
    case "message.streaming":
      if (!event.content) return []
      return mapper.mapSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: event.content,
        messageId: event.messageId,
      })

    case "message.complete":
      if (event.role === "user") {
        return [{
          type: "user.message",
          id: event.messageId ?? crypto.randomUUID(),
          content: event.content,
        }]
      }
      if (event.role === "assistant") {
        return mapper.finishMessage()
      }
      return []

    case "thinking.streaming":
      if (!event.content) return []
      return mapper.mapSessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: event.content,
        messageId: event.messageId,
      })

    case "thinking.complete":
    case "thinking":
      // Thinking complete doesn't need separate handling -
      // finishMessage will be called on message.complete
      return []

    case "tool.start":
      return [{
        type: "tool_call.start",
        toolCallId: event.toolCallId ?? crypto.randomUUID(),
        toolName: event.toolName,
        input: event.toolInput ? parseJsonSafe(event.toolInput) : undefined,
      }]

    case "tool.update":
      if (!event.toolCallId) return []
      return [{
        type: "tool_call.update",
        toolCallId: event.toolCallId,
        status: event.status === "running" ? "running" : "running",
        result: event.toolResult,
      }]

    case "tool.end":
      if (!event.toolCallId) return []
      return [{
        type: "tool_call.update",
        toolCallId: event.toolCallId,
        status: event.status === "error" ? "error" : "done",
        result: event.toolResult,
      }]

    case "plan":
      if (!event.entries?.length) return []
      return [{
        type: "plan",
        id: `plan-${Date.now()}`,
        entries: event.entries.map((e, idx) => ({
          id: `plan-item-${idx}`,
          title: e.content,
          status: mapPlanStatus(e.status),
        })),
      }]

    case "usage":
      if (!event.contextTokens && !event.contextWindowMax) return []
      return [{
        type: "usage",
        ...(event.contextTokens ? { contextTokens: event.contextTokens } : {}),
        ...(event.contextWindowMax ? { contextWindowMax: event.contextWindowMax } : {}),
      }]

    case "permission.request":
      if (!event.requestId || !event.options) return []
      // Find the most recent tool call to attach permission to
      // This is emitted separately, client should correlate by pending_permission status
      return [{
        type: "tool_call.update",
        toolCallId: event.toolCallId ?? "unknown",
        status: "pending_permission",
        permissionRequest: {
          requestId: event.requestId,
          options: event.options.map((opt) => ({
            id: opt.optionId,
            name: opt.name,
            description: opt.kind,
          })),
        },
      }]

    default:
      return []
  }
}

function parseJsonSafe(str: string): unknown {
  try {
    return JSON.parse(str)
  } catch {
    return str
  }
}
