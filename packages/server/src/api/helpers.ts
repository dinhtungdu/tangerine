import type { Task, TaskSource, TaskStatus } from "@tangerine/shared"
import type { TaskRow } from "../db/types"

/** Maps a snake_case TaskRow from SQLite to a camelCase Task for API responses */
export function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    source: row.source as TaskSource,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    vmId: row.vm_id,
    branch: row.branch,
    prUrl: row.pr_url,
    userId: row.user_id,
    opencodeSessionId: row.opencode_session_id,
    opencodePort: row.opencode_port,
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
