// Unified activity logging service.
// All task events flow through logActivity() — lifecycle, file changes, agent chat.

import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { emitTaskEvent } from "./tasks/events"
import { utc } from "./api/helpers"
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

export interface ToolActivityUpdate {
  toolCallId?: string
  toolName?: string
  toolInput?: string
  toolResult?: string
  status?: "running" | "success" | "error"
  activityType?: ActivityType
  activityEvent?: string
}

interface ActivityLogRow {
  id: number
  task_id: string
  type: string
  event: string
  content: string
  metadata: string | null
  timestamp: string
}

/** Log an activity for a task. This is the single entry point for all activity types. */
export function logActivity(
  db: Database,
  taskId: string,
  type: ActivityType,
  event: string,
  content: string,
  metadata?: Record<string, unknown>,
): Effect.Effect<ActivityEntry, Error> {
  return Effect.try({
    try: () => {
      const stmt = db.prepare(`
        INSERT INTO activity_log (task_id, type, event, content, metadata)
        VALUES ($task_id, $type, $event, $content, $metadata)
      `)
      const result = stmt.run({
        $task_id: taskId,
        $type: type,
        $event: event,
        $content: content,
        $metadata: metadata ? JSON.stringify(metadata) : null,
      })
      const row = db.prepare("SELECT * FROM activity_log WHERE id = ?").get(result.lastInsertRowid) as ActivityLogRow
      const entry = mapRow(row)
      // Broadcast to connected WS clients
      emitTaskEvent(taskId, { type: "activity", entry })
      return entry
    },
    catch: (e) => new Error(`Failed to log activity: ${e}`),
  })
}

/** Get all activities for a task, ordered by timestamp ascending. */
export function getActivities(
  db: Database,
  taskId: string,
): Effect.Effect<ActivityEntry[], Error> {
  return Effect.try({
    try: () => {
      const rows = db.prepare("SELECT * FROM activity_log WHERE task_id = ? ORDER BY timestamp ASC").all(taskId) as ActivityLogRow[]
      return rows.map(mapRow)
    },
    catch: (e) => new Error(`Failed to get activities: ${e}`),
  })
}

/** Merge ACP tool-call progress/result data into the existing tool activity row. */
export function updateToolActivity(
  db: Database,
  taskId: string,
  update: ToolActivityUpdate,
): Effect.Effect<ActivityEntry | null, Error> {
  return Effect.try({
    try: () => {
      const row = findToolActivityRow(db, taskId, update)
      const metadata = mergeToolActivityMetadata(row ? parseMetadata(row.metadata) : {}, update, new Date().toISOString())
      if (!row) {
        if (!update.activityType || !update.activityEvent) return null
        const result = db.prepare(`
          INSERT INTO activity_log (task_id, type, event, content, metadata)
          VALUES ($task_id, $type, $event, $content, $metadata)
        `).run({
          $task_id: taskId,
          $type: update.activityType,
          $event: update.activityEvent,
          $content: update.toolName ?? update.activityEvent,
          $metadata: JSON.stringify(metadata),
        })
        const insertedRow = db.prepare("SELECT * FROM activity_log WHERE id = ?").get(result.lastInsertRowid) as ActivityLogRow
        const inserted = mapRow(insertedRow)
        emitTaskEvent(taskId, { type: "activity", entry: inserted })
        return inserted
      }
      const nextType = update.activityType ?? row.type
      const nextEvent = update.activityEvent ?? row.event
      const nextContent = update.toolName ?? row.content
      db.prepare("UPDATE activity_log SET type = ?, event = ?, content = ?, metadata = ? WHERE id = ?")
        .run(nextType, nextEvent, nextContent, JSON.stringify(metadata), row.id)
      const updatedRow = db.prepare("SELECT * FROM activity_log WHERE id = ?").get(row.id) as ActivityLogRow
      const entry = mapRow(updatedRow)
      emitTaskEvent(taskId, { type: "activity", entry })
      return entry
    },
    catch: (e) => new Error(`Failed to update tool activity: ${e}`),
  })
}

/** Check if a specific activity event exists for a task. */
export function hasActivityEvent(
  db: Database,
  taskId: string,
  event: string,
): Effect.Effect<boolean, Error> {
  return Effect.try({
    try: () => {
      const row = db.prepare("SELECT 1 FROM activity_log WHERE task_id = ? AND event = ? LIMIT 1").get(taskId, event)
      return row != null
    },
    catch: (e) => new Error(`Failed to check activity event: ${e}`),
  })
}

/** Delete activity entries for tasks that no longer exist. Silent on error. */
export function cleanupActivities(db: Database): void {
  try {
    db.run("DELETE FROM activity_log WHERE task_id NOT IN (SELECT id FROM tasks)")
  } catch {
    // Silent — cleanup must never crash the app
  }
}

function mergeToolActivityMetadata(previous: Record<string, unknown>, update: ToolActivityUpdate, lastProgressAt: string): Record<string, unknown> {
  const next = {
    ...previous,
    ...(update.toolCallId !== undefined ? { toolCallId: update.toolCallId } : {}),
    ...(update.toolName !== undefined ? { toolName: update.toolName } : {}),
    ...(update.toolInput !== undefined ? { toolInput: update.toolInput } : {}),
    ...(update.status !== undefined ? { status: mergeToolStatus(previous.status, update.status) } : {}),
    ...(update.toolResult !== undefined ? { output: update.toolResult } : {}),
  }
  return update.toolInput !== undefined || update.toolResult !== undefined
    ? { ...next, lastProgressAt }
    : next
}

function mergeToolStatus(previous: unknown, next: NonNullable<ToolActivityUpdate["status"]>): ToolActivityUpdate["status"] {
  if ((previous === "success" || previous === "error") && next === "running") return previous
  return next
}

function findToolActivityRow(db: Database, taskId: string, update: ToolActivityUpdate): ActivityLogRow | null {
  const rows = db.prepare(
    "SELECT * FROM activity_log WHERE task_id = ? AND event LIKE 'tool.%' ORDER BY id DESC LIMIT 100"
  ).all(taskId) as ActivityLogRow[]

  if (update.toolCallId) {
    const match = rows.find((row) => parseMetadata(row.metadata).toolCallId === update.toolCallId)
    if (match) return match
  }

  if (update.toolName) {
    const match = rows.find((row) => {
      const metadata = parseMetadata(row.metadata)
      return metadata.toolName === update.toolName && metadata.status === "running"
    })
    if (match) return match
  }

  return null
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function mapRow(row: ActivityLogRow): ActivityEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type as ActivityType,
    event: row.event,
    content: row.content,
    metadata: row.metadata ? parseMetadata(row.metadata) : null,
    timestamp: utc(row.timestamp) ?? row.timestamp,
  }
}

