import type { Task, PoolStats, ProjectConfig } from "@tangerine/shared"

const BASE = ""

export interface SessionLog {
  id: number
  taskId: string
  role: string
  content: string
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

export async function fetchProjects(): Promise<{ projects: ProjectConfig[]; model: string }> {
  return request<{ projects: ProjectConfig[]; model: string }>("/api/projects")
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

export async function createTask(data: {
  projectId: string
  title: string
  description?: string
}): Promise<Task> {
  return request<Task>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(data),
  })
}

export async function cancelTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/cancel`, { method: "POST" })
}

export async function completeTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${id}/done`, { method: "POST" })
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

export async function fetchDiff(id: string): Promise<DiffData> {
  return request<DiffData>(`/api/tasks/${id}/diff`)
}

export async function fetchPool(): Promise<PoolStats> {
  return request<PoolStats>("/api/pool")
}

export async function fetchHealth(): Promise<{ status: string; uptime: number }> {
  return request<{ status: string; uptime: number }>("/api/health")
}
