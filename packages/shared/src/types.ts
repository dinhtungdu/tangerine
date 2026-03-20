export type TaskStatus = "created" | "provisioning" | "running" | "done" | "failed" | "cancelled"
export type VmStatus = "provisioning" | "active" | "stopped" | "destroyed" | "error"
export type ProviderType = "opencode" | "claude-code"
export type TaskSource = "github" | "linear" | "manual"

export interface Task {
  id: string
  projectId: string
  source: TaskSource
  sourceId: string | null
  sourceUrl: string | null
  title: string
  description: string | null
  status: TaskStatus
  provider: ProviderType
  model: string | null
  vmId: string | null
  branch: string | null
  worktreePath: string | null
  prUrl: string | null
  userId: string | null
  agentSessionId: string | null
  agentPort: number | null
  previewPort: number | null
  error: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export type ActivityType = "lifecycle" | "file" | "system"

export interface ActivityEntry {
  id: number
  taskId: string
  type: ActivityType
  event: string
  content: string
  metadata: Record<string, unknown> | null
  timestamp: string
}

// WebSocket message types
export type WsServerMessage =
  | { type: "connected" }
  | { type: "event"; data: unknown }
  | { type: "status"; status: TaskStatus }
  | { type: "error"; message: string }

export type WsClientMessage =
  | { type: "prompt"; text: string }
  | { type: "abort" }

// System logs
export type LogLevel = "debug" | "info" | "warn" | "error"

export interface SystemLogEntry {
  id: number
  timestamp: string
  level: LogLevel
  logger: string
  message: string
  context: Record<string, unknown> | null
}
