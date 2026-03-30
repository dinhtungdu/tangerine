import type { Task, ProjectConfig, SystemLogEntry, ActivityEntry } from "@tangerine/shared"

const BASE = ""

export interface SessionLog {
  id: number
  taskId: string
  role: string
  content: string
  images: string | null
  timestamp: string
}

export interface DiffFile {
  path: string
  diff: string
}

export interface DiffData {
  files: DiffFile[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "Unknown error")
    throw new Error(`${res.status}: ${body}`)
  }
  // Some endpoints return no content
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function fetchProjects(): Promise<{
  projects: ProjectConfig[]
  model: string
  models: string[]
  modelsByProvider: Record<string, string[]>
}> {
  return request<{
    projects: ProjectConfig[]
    model: string
    models: string[]
    modelsByProvider: Record<string, string[]>
  }>("/api/projects")
}

export async function fetchTasks(filter?: { status?: string; project?: string; search?: string }): Promise<Task[]> {
  const params = new URLSearchParams()
  if (filter?.status) params.set("status", filter.status)
  if (filter?.project) params.set("project", filter.project)
  if (filter?.search) params.set("search", filter.search)
  const query = params.toString() ? `?${params}` : ""
  return request<Task[]>(`/api/tasks${query}`)
}

export async function fetchTask(id: string): Promise<Task> {
  return request<Task>(`/api/tasks/${id}`)
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
}): Promise<Task> {
  return request<Task>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(data),
  })
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

export async function sendPrompt(id: string, text: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
  })
}

export async function abortTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/abort`, { method: "POST" })
}

export async function changeTaskConfig(id: string, config: { model?: string; reasoningEffort?: string }): Promise<void> {
  return request<void>(`/api/tasks/${id}/model`, {
    method: "POST",
    body: JSON.stringify(config),
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

export async function retryTask(id: string): Promise<Task> {
  return request<Task>(`/api/tasks/${id}/retry`, { method: "POST" })
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
}

export interface ProjectUpdateResult {
  updated: boolean
  from: string
  to: string
  postUpdateOutput?: string
  restart?: boolean
}

export async function ensureOrchestrator(projectName: string, provider?: string): Promise<Task> {
  return request<Task>(`/api/projects/${encodeURIComponent(projectName)}/orchestrator`, {
    method: "POST",
    body: JSON.stringify({ provider }),
  })
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

export async function updateProjectRepo(projectName: string): Promise<ProjectUpdateResult> {
  return request<ProjectUpdateResult>(`/api/projects/${encodeURIComponent(projectName)}/update`, {
    method: "POST",
  })
}

