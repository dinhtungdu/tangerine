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

function mapRow(row: ActivityLogRow): ActivityEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type as ActivityType,
    event: row.event,
    content: row.content,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    timestamp: utc(row.timestamp) ?? row.timestamp,
  }
}

