// Thread model - based on Zed's AgentThreadEntry

export type MessageChunk =
  | { type: "message"; content: string }
  | { type: "thought"; content: string }

export type ThreadEntry =
  | UserEntry
  | AssistantEntry
  | ToolCallEntry
  | PlanEntry

export interface UserEntry {
  kind: "user"
  id: string
  content: string
  timestamp: string
  images?: MessageImage[]
}

export interface AssistantEntry {
  kind: "assistant"
  id: string
  chunks: MessageChunk[]
  timestamp: string
  streaming: boolean
}

export interface ToolCallEntry {
  kind: "tool_call"
  id: string
  toolCallId: string
  toolName: string
  input: unknown
  status: ToolCallStatus
  result?: string
  permissionRequest?: PermissionRequest
}

export interface PlanEntry {
  kind: "plan"
  id: string
  entries: PlanItem[]
  timestamp: string
}

export type ToolCallStatus = "pending_permission" | "running" | "done" | "error"

export interface PermissionRequest {
  requestId: string
  options: Array<{ id: string; name: string; description?: string }>
}

export interface MessageImage {
  src: string
  mediaType?: string
}

export interface PlanItem {
  id: string
  title: string
  status: "pending" | "in_progress" | "done"
}
