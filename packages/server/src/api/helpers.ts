import type { Task, TaskSource, TaskStatus, ProviderType, TaskCapability } from "@tangerine/shared"
import { ORCHESTRATOR_TASK_NAME } from "@tangerine/shared"
import type { TaskRow } from "../db/types"

/**
 * SQLite datetime('now') produces UTC timestamps without a Z suffix
 * (e.g. "2026-03-19 22:37:49"). JS Date() parses bare timestamps as
 * local time, causing wrong relative times. Append Z so they parse as UTC.
 */
export function utc(ts: string | null): string | null {
  if (!ts) return null
  // Already has timezone info (ends with Z, or +/-HH:MM offset)
  if (/Z$|[+-]\d{2}:\d{2}$/.test(ts)) return ts
  // Bare SQLite timestamp — append Z
  return ts.replace(" ", "T") + "Z"
}

// Fallback capabilities for rows that predate the capabilities column (capabilities IS NULL).
// Use title to distinguish orchestrators from worker tasks so upgraded installs work correctly.
function defaultCapabilities(title: string): TaskCapability[] {
  return title === ORCHESTRATOR_TASK_NAME
    ? ["restart"]
    : ["resolve", "predefined-prompts", "diff"]
}

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
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    branch: row.branch,
    worktreePath: row.worktree_path,
    prUrl: row.pr_url,
    parentTaskId: row.parent_task_id,
    userId: row.user_id,
    agentSessionId: row.agent_session_id,
    agentPid: row.agent_pid,
    error: row.error,
    createdAt: utc(row.created_at)!,
    updatedAt: utc(row.updated_at)!,
    startedAt: utc(row.started_at),
    completedAt: utc(row.completed_at),
    lastSeenAt: utc(row.last_seen_at),
    lastResultAt: utc(row.last_result_at),
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : defaultCapabilities(row.title),
  }
}

/** Normalize all timestamp-like string fields in an object to UTC (append Z) */
export function normalizeTimestamps<T extends object>(row: T): T {
  const result = { ...row } as Record<string, unknown>
  for (const key of Object.keys(result)) {
    const val = result[key]
    if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(val)) {
      result[key] = val.replace(" ", "T") + "Z"
    }
  }
  return result as T
}

/** Generates a unique ID using the built-in crypto API */
export function generateId(): string {
  return crypto.randomUUID()
}
