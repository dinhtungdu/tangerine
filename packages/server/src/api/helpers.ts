import type { Task, TaskSource, TaskStatus, ProviderType } from "@tangerine/shared"
import type { TaskRow } from "../db/types"

/** Maps a snake_case TaskRow from SQLite to a camelCase Task for API responses */
export function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    source: row.source as TaskSource,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    provider: row.provider as ProviderType,
    vmId: row.vm_id,
    branch: row.branch,
    worktreePath: row.worktree_path,
    prUrl: row.pr_url,
    userId: row.user_id,
    agentSessionId: row.agent_session_id,
    agentPort: row.agent_port,
    previewPort: row.preview_port,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

/** Generates a unique ID using the built-in crypto API */
export function generateId(): string {
  return crypto.randomUUID()
}
