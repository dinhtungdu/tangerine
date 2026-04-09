import type { Task, Cron, TaskType, TaskSource, TaskStatus, ProviderType, TaskCapability } from "@tangerine/shared"
import type { TaskRow, CronRow } from "../db/types"

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

// Canonical capabilities per task type. Used as baseline for all tasks.
function canonicalCapabilities(type: string): TaskCapability[] {
  if (type === "orchestrator") return ["resolve", "predefined-prompts"]
  if (type === "reviewer") return ["resolve", "predefined-prompts", "diff", "pr-track"]
  return ["resolve", "predefined-prompts", "diff", "continue", "pr-track", "pr-create"]
}

// Merge stored capabilities with canonical ones so that:
// - New capabilities added to the canonical set appear on existing rows
// - Custom per-task capabilities stored in the DB are preserved
function mergeCapabilities(stored: string | null, type: string): TaskCapability[] {
  const canonical = canonicalCapabilities(type)
  if (!stored) return canonical
  const parsed: TaskCapability[] = JSON.parse(stored)
  const merged = new Set([...canonical, ...parsed])
  return [...merged]
}

/** Maps a snake_case TaskRow from SQLite to a camelCase Task for API responses */
export function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    type: (row.type ?? "worker") as TaskType,
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
    suspended: !!row.suspended,
    error: row.error,
    createdAt: utc(row.created_at)!,
    updatedAt: utc(row.updated_at)!,
    startedAt: utc(row.started_at),
    completedAt: utc(row.completed_at),
    lastSeenAt: utc(row.last_seen_at),
    lastResultAt: utc(row.last_result_at),
    capabilities: mergeCapabilities(row.capabilities, row.type ?? "worker"),
  }
}

/** Maps a snake_case CronRow from SQLite to a camelCase Cron for API responses */
export function mapCronRow(row: CronRow): Cron {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    cron: row.cron,
    enabled: row.enabled === 1,
    nextRunAt: utc(row.next_run_at),
    taskDefaults: row.task_defaults ? JSON.parse(row.task_defaults) : null,
    createdAt: utc(row.created_at)!,
    updatedAt: utc(row.updated_at)!,
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

/** Check if a task (by type + stored capabilities) has a given capability. */
export function taskHasCapability(type: string, storedCapabilities: string | null, cap: TaskCapability): boolean {
  const canonical = canonicalCapabilities(type)
  if (canonical.includes(cap)) return true
  if (!storedCapabilities) return false
  const parsed: TaskCapability[] = JSON.parse(storedCapabilities)
  return parsed.includes(cap)
}

/** Generates a unique ID using the built-in crypto API */
export function generateId(): string {
  return crypto.randomUUID()
}
