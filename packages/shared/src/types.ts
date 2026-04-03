export type TaskStatus = "created" | "provisioning" | "running" | "done" | "failed" | "cancelled"
export type ProviderType = "opencode" | "claude-code" | "codex" | "pi"
export type TaskSource = "github" | "linear" | "manual" | "cross-project" | "cron"
export type TaskType = "worker" | "orchestrator" | "reviewer"
export type TaskCapability = "resolve" | "predefined-prompts" | "diff" | "continue" | "pr-track" | "pr-create"
export interface Task {
  id: string
  projectId: string
  type: TaskType
  source: TaskSource
  sourceId: string | null
  sourceUrl: string | null
  title: string
  description: string | null
  status: TaskStatus
  provider: ProviderType
  model: string | null
  reasoningEffort: string | null
  branch: string | null
  worktreePath: string | null
  prUrl: string | null
  parentTaskId: string | null
  userId: string | null
  agentSessionId: string | null
  agentPid: number | null
  error: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  lastSeenAt: string | null
  lastResultAt: string | null
  capabilities: TaskCapability[]
}

export interface Cron {
  id: string
  projectId: string
  title: string
  description: string | null
  cron: string
  enabled: boolean
  nextRunAt: string | null
  taskDefaults: { provider?: string; model?: string; reasoningEffort?: string; branch?: string } | null
  createdAt: string
  updatedAt: string
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
  | { type: "activity"; entry: ActivityEntry }
  | { type: "status"; status: TaskStatus }
  | { type: "agent_status"; agentStatus: "idle" | "working" }
  | { type: "error"; message: string }

export interface PromptImage {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  data: string // base64-encoded bytes (no data: URL prefix)
}

export type WsClientMessage =
  | { type: "prompt"; text: string; images?: PromptImage[] }
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
  taskId: string | null
}
