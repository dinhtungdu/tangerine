// System log: captures infra logs to SQLite for the Status page.
// Write failures are silently swallowed — logging must never crash the app.

import type { Database } from "bun:sqlite"
import type { LogLevel, SystemLogEntry } from "@tangerine/shared"

export const INFRA_LOGGERS = new Set([
  "pool",
  "ssh",
  "health",
  "cleanup",
  "retry",
  "tasks",
  "cli",
  "cli:pool",
  "cli:image",
  "cli:task",
  "github",
  "image:build",
])

let _db: Database | null = null

export function initSystemLog(db: Database): void {
  _db = db
}

export function writeSystemLog(
  level: LogLevel,
  logger: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  if (!_db) return
  try {
    const taskId = (context?.taskId as string) ?? null
    _db.run(
      "INSERT INTO system_logs (level, logger, message, context, task_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      [level, logger, message, context ? JSON.stringify(context) : null, taskId, new Date().toISOString()],
    )
  } catch {
    // Silent — logging must never crash the app
  }
}

export interface LogFilter {
  level?: string[]
  logger?: string[]
  taskId?: string
  projectId?: string
  limit?: number
  since?: string
}

export function querySystemLogs(db: Database, filter?: LogFilter): SystemLogEntry[] {
  const conditions: string[] = []
  const params: (string | number)[] = []
  let join = ""

  if (filter?.level?.length) {
    conditions.push(`sl.level IN (${filter.level.map(() => "?").join(",")})`)
    params.push(...filter.level)
  }
  if (filter?.logger?.length) {
    conditions.push(`sl.logger IN (${filter.logger.map(() => "?").join(",")})`)
    params.push(...filter.logger)
  }
  if (filter?.taskId) {
    conditions.push("sl.task_id = ?")
    params.push(filter.taskId)
  }
  if (filter?.projectId) {
    join = "LEFT JOIN tasks t ON sl.task_id = t.id"
    conditions.push("(t.project_id = ? OR sl.task_id IS NULL)")
    params.push(filter.projectId)
  }
  if (filter?.since) {
    conditions.push("sl.timestamp >= ?")
    params.push(filter.since)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
  const limit = Math.min(filter?.limit ?? 200, 1000)
  params.push(limit)

  const rows = db.query(
    `SELECT sl.id, sl.level, sl.logger, sl.message, sl.context, sl.task_id, sl.timestamp FROM system_logs sl ${join} ${where} ORDER BY sl.id DESC LIMIT ?`,
  ).all(...params) as Array<{
    id: number
    level: string
    logger: string
    message: string
    context: string | null
    task_id: string | null
    timestamp: string
  }>

  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    level: r.level as LogLevel,
    logger: r.logger,
    message: r.message,
    context: r.context ? (JSON.parse(r.context) as Record<string, unknown>) : null,
    taskId: r.task_id,
  }))
}

export function cleanupSystemLogs(db: Database, maxRows = 10_000, maxDays = 7): void {
  try {
    const cutoff = new Date(Date.now() - maxDays * 86_400_000).toISOString()
    db.run("DELETE FROM system_logs WHERE timestamp < ?", [cutoff])

    const countResult = db.query("SELECT COUNT(*) as cnt FROM system_logs").get() as { cnt: number }
    if (countResult.cnt > maxRows) {
      db.run(
        "DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT ?)",
        [maxRows],
      )
    }
  } catch {
    // Silent
  }
}
