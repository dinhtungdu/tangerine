import { getCapabilitiesForType, normalizeTaskType, type Task, type TaskSource, type TaskStatus, type ProviderType, type TaskCapability } from "@tangerine/shared"
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

// Canonical capabilities from type, plus provider-dependent capabilities from DB.
// Canonical set is rebuilt each call so removing a capability takes effect immediately.
// Provider-dependent capabilities (e.g. "tui") are only present in stored and must be preserved.
const PROVIDER_DEPENDENT_CAPABILITIES: Set<TaskCapability> = new Set(["tui"])

function mergeCapabilities(stored: string | null, task: { type?: string | null }): TaskCapability[] {
  const canonical = getCapabilitiesForType(normalizeTaskType(task.type))
  if (!stored) return canonical
  try {
    const parsed: TaskCapability[] = JSON.parse(stored)
    for (const cap of parsed) {
      if (PROVIDER_DEPENDENT_CAPABILITIES.has(cap) && !canonical.includes(cap)) {
        canonical.push(cap)
      }
    }
  } catch { /* malformed stored capabilities — ignore */ }
  return canonical
}

/** Maps a snake_case TaskRow from SQLite to a camelCase Task for API responses */
export function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    type: normalizeTaskType(row.type),
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
    prStatus: row.pr_status as Task["prStatus"],
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
    capabilities: mergeCapabilities(row.capabilities, row),
    contextTokens: row.context_tokens ?? 0,
    contextWindowMax: row.context_window_max ?? null,
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
  const canonical = getCapabilitiesForType(normalizeTaskType(type))
  if (canonical.includes(cap)) return true
  if (!storedCapabilities) return false
  const parsed: TaskCapability[] = JSON.parse(storedCapabilities)
  return parsed.includes(cap)
}