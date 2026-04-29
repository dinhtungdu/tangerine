import type { AgentConfig, AgentConfigOption, AgentSlashCommand, Task, TaskWriteResponse, ProjectConfig, SystemLogEntry, ActivityEntry, ActionCombo, ShortcutConfig, SystemCapabilities, PromptImage, PromptQueueEntry } from "@tangerine/shared"
import { buildAuthHeaders, emitAuthFailure } from "./auth"

const BASE = ""

export interface AuthSession {
  enabled: boolean
  authenticated: boolean
}

export class ApiError extends Error {
  status: number
  body: string

  constructor(status: number, body: string) {
    super(`${status}: ${body}`)
    this.status = status
    this.body = body
  }
}

export interface SessionLog {
  id: number | string
  taskId: string
  role: string
  messageId?: string | null
  message_id?: string | null
  content: string
  images: string | null
  timestamp: string
  transient?: boolean
}

export interface DiffFile {
  path: string
  diff: string
}

export interface DiffData {
  files: DiffFile[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = buildAuthHeaders(init?.headers)
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "Unknown error")
    if (res.status === 401) emitAuthFailure()
    throw new ApiError(res.status, body)
  }
  // Some endpoints return no content
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function fetchAuthSession(): Promise<AuthSession> {
  return request<AuthSession>("/api/auth/session")
}

export async function fetchProjects(): Promise<{
  projects: ProjectConfig[]
  model: string
  agents?: AgentConfig[]
  defaultAgent?: string
  systemCapabilities?: SystemCapabilities
  sshHost?: string
  sshUser?: string
  editor?: "vscode" | "cursor" | "zed"
  actionCombos: ActionCombo[]
  shortcuts?: Record<string, ShortcutConfig>
}> {
  return request<{
    projects: ProjectConfig[]
    model: string
    agents?: AgentConfig[]
    defaultAgent?: string
    systemCapabilities?: SystemCapabilities
    sshHost?: string
    sshUser?: string
    editor?: "vscode" | "cursor" | "zed"
    actionCombos: ActionCombo[]
    shortcuts?: Record<string, ShortcutConfig>
  }>("/api/projects")
}

export async function fetchTasks(filter?: { status?: string; project?: string; search?: string; limit?: number; offset?: number }): Promise<Task[]> {
  const params = new URLSearchParams()
  if (filter?.status) params.set("status", filter.status)
  if (filter?.project) params.set("project", filter.project)
  if (filter?.search) params.set("search", filter.search)
  if (filter?.limit !== undefined) params.set("limit", String(filter.limit))
  if (filter?.offset !== undefined) params.set("offset", String(filter.offset))
  const query = params.toString() ? `?${params}` : ""
  return request<Task[]>(`/api/tasks${query}`)
}

export async function fetchTask(id: string): Promise<Task> {
  return request<Task>(`/api/tasks/${id}`)
}

export async function fetchTaskCounts(filter?: { status?: string; search?: string }): Promise<Record<string, number>> {
  const params = new URLSearchParams()
  if (filter?.status) params.set("status", filter.status)
  if (filter?.search) params.set("search", filter.search)
  const query = params.toString() ? `?${params}` : ""
  return request<Record<string, number>>(`/api/tasks/counts${query}`)
}

export async function fetchChildTasks(id: string): Promise<Task[]> {
  return request<Task[]>(`/api/tasks/${id}/children`)
}

export async function createTask(data: {
  projectId: string
  title: string
  description?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  branch?: string
  parentTaskId?: string
  type?: string
  images?: import("@tangerine/shared").PromptImage[]
}): Promise<TaskWriteResponse> {
  return request<TaskWriteResponse>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(data),
  })
}

// --- Crons ---

export async function listCrons(projectId?: string): Promise<import("@tangerine/shared").Cron[]> {
  const params = projectId ? `?project=${projectId}` : ""
  return request<import("@tangerine/shared").Cron[]>(`/api/crons${params}`)
}

export async function createCron(data: {
  projectId: string
  title: string
  description?: string
  cron: string
  enabled?: boolean
  taskDefaults?: { provider?: string; model?: string; reasoningEffort?: string; branch?: string }
}): Promise<import("@tangerine/shared").Cron> {
  return request<import("@tangerine/shared").Cron>("/api/crons", {
    method: "POST",
    body: JSON.stringify(data),
  })
}

export async function updateCron(id: string, data: {
  title?: string
  description?: string | null
  cron?: string
  enabled?: boolean
  taskDefaults?: { provider?: string; model?: string; reasoningEffort?: string; branch?: string } | null
}): Promise<import("@tangerine/shared").Cron> {
  return request<import("@tangerine/shared").Cron>(`/api/crons/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  })
}

export async function deleteCron(id: string): Promise<void> {
  return request<void>(`/api/crons/${id}`, { method: "DELETE" })
}

export async function cancelTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/cancel`, { method: "POST" })
}

export async function resolveTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/resolve`, { method: "POST" })
}

export async function fetchMessages(id: string): Promise<SessionLog[]> {
  return request<SessionLog[]>(`/api/tasks/${id}/messages`)
}

export interface PaginatedMessages {
  messages: SessionLog[]
  hasMore: boolean
}

export async function fetchMessagesPaginated(
  id: string,
  limit: number,
  beforeId?: number
): Promise<PaginatedMessages> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (beforeId !== undefined) params.set("beforeId", String(beforeId))
  return request<PaginatedMessages>(`/api/tasks/${id}/messages?${params}`)
}

export interface SessionSyncResult {
  available: boolean
  inserted: number
  skipped: number
  reason?: "missing-session-id" | "history-load-unsupported"
}

export async function syncTaskSession(id: string): Promise<SessionSyncResult> {
  return request<SessionSyncResult>(`/api/tasks/${id}/sync-session`, { method: "POST" })
}

export async function fetchTaskConfigOptions(id: string): Promise<AgentConfigOption[]> {
  const body = await request<{ configOptions?: AgentConfigOption[] }>(`/api/tasks/${id}/config-options`)
  return Array.isArray(body?.configOptions) ? body.configOptions : []
}

export async function fetchQueuedPrompts(id: string): Promise<PromptQueueEntry[]> {
  const body = await request<{ queuedPrompts?: PromptQueueEntry[] }>(`/api/tasks/${id}/queue`)
  return Array.isArray(body?.queuedPrompts) ? body.queuedPrompts : []
}

export async function updateQueuedPrompt(id: string, promptId: string, text: string, images?: PromptImage[]): Promise<PromptQueueEntry> {
  const body = await request<{ queuedPrompt: PromptQueueEntry }>(`/api/tasks/${id}/queue/${promptId}`, {
    method: "PATCH",
    body: JSON.stringify({ text, images }),
  })
  return body.queuedPrompt
}

export async function removeQueuedPrompt(id: string, promptId: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/queue/${promptId}`, { method: "DELETE" })
}

export async function sendNowQueuedPrompt(id: string, promptId: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/queue/${promptId}/send-now`, { method: "POST" })
}

export async function fetchTaskSlashCommands(id: string): Promise<AgentSlashCommand[]> {
  const body = await request<{ commands?: AgentSlashCommand[] }>(`/api/tasks/${id}/slash-commands`)
  return Array.isArray(body?.commands) ? body.commands : []
}

export async function fetchPendingPermission(id: string): Promise<import("@tangerine/shared").PermissionRequest | null> {
  const body = await request<{ permissionRequest?: import("@tangerine/shared").PermissionRequest | null }>(`/api/tasks/${id}/permission`)
  return body?.permissionRequest ?? null
}

export async function sendPrompt(id: string, text: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
  })
}

export async function abortTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/abort`, { method: "POST" })
}

export async function restartTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/restart`, { method: "POST" })
}

export async function changeTaskConfig(id: string, config: { model?: string; reasoningEffort?: string; mode?: string }): Promise<void> {
  return request<void>(`/api/tasks/${id}/model`, {
    method: "POST",
    body: JSON.stringify(config),
  })
}

export async function respondToPermission(id: string, requestId: string, optionId: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/permission`, {
    method: "POST",
    body: JSON.stringify({ requestId, optionId }),
  })
}

export async function fetchActivities(id: string): Promise<ActivityEntry[]> {
  return request<ActivityEntry[]>(`/api/tasks/${id}/activities`)
}

export async function fetchDiff(id: string): Promise<DiffData> {
  return request<DiffData>(`/api/tasks/${id}/diff`)
}

export async function fetchHealth(): Promise<{ status: string; uptime: number }> {
  return request<{ status: string; uptime: number }>("/api/health")
}

export async function fetchSystemLogs(filter?: {
  level?: string[]
  logger?: string[]
  taskId?: string
  project?: string
  limit?: number
  since?: string
}): Promise<SystemLogEntry[]> {
  const params = new URLSearchParams()
  if (filter?.level?.length) params.set("level", filter.level.join(","))
  if (filter?.logger?.length) params.set("logger", filter.logger.join(","))
  if (filter?.taskId) params.set("taskId", filter.taskId)
  if (filter?.project) params.set("project", filter.project)
  if (filter?.limit) params.set("limit", String(filter.limit))
  if (filter?.since) params.set("since", filter.since)
  const query = params.toString() ? `?${params}` : ""
  return request<SystemLogEntry[]>(`/api/logs${query}`)
}

export async function markTaskSeen(id: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/seen`, { method: "POST" })
}

export async function retryTask(id: string): Promise<TaskWriteResponse> {
  return request<TaskWriteResponse>(`/api/tasks/${id}/retry`, { method: "POST" })
}

export async function deleteTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${id}`, { method: "DELETE" })
}

export interface OrphanInfo {
  id: string
  title: string
  status: string
  worktreePath: string
}

export async function fetchOrphans(): Promise<OrphanInfo[]> {
  return request<OrphanInfo[]>("/api/cleanup/orphans")
}

export async function cleanupOrphans(): Promise<{ cleaned: number }> {
  return request<{ cleaned: number }>("/api/cleanup/orphans", { method: "POST" })
}

export interface ProjectUpdateStatus {
  available: boolean
  local: string
  remote: string
  checkedAt: string | null
  isFork: boolean
  parentSlug: string | null
}

export interface ForkSyncResult {
  synced: boolean
  upstream: string | null
}

export interface ProjectUpdateResult {
  updated: boolean
  from: string
  to: string
  postUpdateOutput?: string
  restart?: boolean
}

export async function startTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/start`, { method: "POST" })
}

export async function fetchUpdateStatus(projectName: string): Promise<ProjectUpdateStatus> {
  return request<ProjectUpdateStatus>(`/api/projects/${encodeURIComponent(projectName)}/update-status`)
}

export async function updateProject(name: string, updates: Partial<ProjectConfig>): Promise<ProjectConfig> {
  return request<ProjectConfig>(`/api/projects/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  })
}

export async function archiveProject(projectName: string): Promise<void> {
  return request<void>(`/api/projects/${encodeURIComponent(projectName)}/archive`, { method: "POST" })
}

export async function unarchiveProject(projectName: string): Promise<void> {
  return request<void>(`/api/projects/${encodeURIComponent(projectName)}/unarchive`, { method: "POST" })
}

export async function syncProjectFork(projectName: string): Promise<ForkSyncResult> {
  return request<ForkSyncResult>(`/api/projects/${encodeURIComponent(projectName)}/fork-sync`, {
    method: "POST",
  })
}

export async function updateProjectRepo(projectName: string): Promise<ProjectUpdateResult> {
  return request<ProjectUpdateResult>(`/api/projects/${encodeURIComponent(projectName)}/update`, {
    method: "POST",
  })
}
