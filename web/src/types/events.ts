// Stream events - server to client

import type { MessageImage, PermissionRequest, PlanItem, ToolCallStatus } from "./thread"

export type StreamEvent =
  | ChunkStartEvent
  | ChunkDeltaEvent
  | AssistantDoneEvent
  | ToolCallStartEvent
  | ToolCallUpdateEvent
  | UserMessageEvent
  | PlanEvent

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
  status: ToolCallStatus
  result?: string
  permissionRequest?: PermissionRequest
}

export interface UserMessageEvent {
  type: "user.message"
  id: string
  content: string
  images?: MessageImage[]
}

export interface PlanEvent {
  type: "plan"
  id: string
  entries: PlanItem[]
}
