export type TaskStatus = "created" | "provisioning" | "running" | "done" | "failed" | "cancelled"
export type VmStatus = "provisioning" | "ready" | "assigned" | "destroying" | "destroyed" | "error"
export type TaskSource = "github" | "linear" | "manual"

export interface Task {
  id: string
  source: TaskSource
  sourceId: string | null
  sourceUrl: string | null
  title: string
  description: string | null
  status: TaskStatus
  vmId: string | null
  branch: string | null
  prUrl: string | null
  userId: string | null
  opencodeSessionId: string | null
  opencodePort: number | null
  previewPort: number | null
  error: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface PoolStats {
  ready: number
  assigned: number
  provisioning: number
  total: number
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
