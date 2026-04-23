import { SUPPORTED_PROVIDERS } from "./constants"

export type TaskStatus = "created" | "provisioning" | "running" | "done" | "failed" | "cancelled"
export type ProviderType = typeof SUPPORTED_PROVIDERS[number]
export type TaskSource = "github" | "linear" | "manual" | "cross-project" | "cron" | "branch"
export type TaskType = "worker" | "orchestrator" | "reviewer" | "runner"
export type TaskCapability = "resolve" | "predefined-prompts" | "diff" | "continue" | "pr-track" | "pr-create"

/** Returns canonical capabilities for a task type. Used to gate UI on capabilities, not type strings. */
export function getCapabilitiesForType(type: TaskType): TaskCapability[] {
  if (type === "orchestrator") return ["resolve", "predefined-prompts"]
  if (type === "runner") return ["resolve", "diff", "continue"]
  if (type === "reviewer") return ["resolve", "predefined-prompts", "diff", "pr-track"]
  return ["resolve", "predefined-prompts", "diff", "continue", "pr-track", "pr-create"]
}
export interface TaskWriteResponse {
  id: string
  title: string
  status: TaskStatus
}

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
  suspended: boolean
  error: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  lastSeenAt: string | null
  lastResultAt: string | null
  capabilities: TaskCapability[]
  agentStatus?: "idle" | "working"
  contextTokens: number
  branchedFromCheckpointId: string | null
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
  | { type: "task_agent_status"; taskId: string; agentStatus: "idle" | "working" }
  | { type: "error"; message: string }
  | { type: "ping" }

export interface PromptImage {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  data: string // base64-encoded bytes (no data: URL prefix)
}

export type WsClientMessage =
  | { type: "auth"; token: string }
  | { type: "prompt"; text: string; images?: PromptImage[] }
  | { type: "abort" }
  | { type: "pong" }

// System-level tool availability detected at server startup
export interface SystemCapabilities {
  git: { available: boolean }
  gh: { available: boolean; authenticated: boolean }
  providers: Record<string, { available: boolean; cliCommand: string }>
}

/** Check if a provider CLI is available. Returns true when capabilities are unknown (null). */
export function isProviderAvailable(capabilities: SystemCapabilities | null, provider: string): boolean {
  if (!capabilities) return true
  return capabilities.providers[provider]?.available !== false
}

export interface Checkpoint {
  id: string
  taskId: string
  sessionLogId: number
  commitSha: string
  turnIndex: number
  createdAt: string
}

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
