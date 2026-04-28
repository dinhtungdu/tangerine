import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { DEFAULT_AGENT_ID } from "@tangerine/shared"
import type { TaskRow, CronRow, SessionLogRow } from "./types"
import { DbError } from "../errors"

function dbTry<T>(op: () => T): Effect.Effect<T, DbError> {
  return Effect.try({
    try: op,
    catch: (e) => new DbError({ message: String(e), cause: e }),
  })
}

// --- Tasks ---

export function createTask(
  db: Database,
  task: Pick<TaskRow, "id" | "project_id" | "source" | "title"> &
    Partial<Pick<TaskRow, "source_id" | "source_url" | "type" | "description" | "user_id" | "branch" | "pr_url" | "provider" | "model" | "reasoning_effort" | "parent_task_id" | "capabilities">>
): Effect.Effect<TaskRow, DbError> {
  return dbTry(() => {
    const stmt = db.prepare(`
      INSERT INTO tasks (id, project_id, source, source_id, source_url, title, type, description, user_id, branch, pr_url, provider, model, reasoning_effort, parent_task_id, capabilities)
      VALUES ($id, $project_id, $source, $source_id, $source_url, $title, $type, $description, $user_id, $branch, $pr_url, $provider, $model, $reasoning_effort, $parent_task_id, $capabilities)
    `)
    stmt.run({
      $id: task.id,
      $project_id: task.project_id,
      $source: task.source,
      $source_id: task.source_id ?? null,
      $source_url: task.source_url ?? null,
      $title: task.title,
      $type: task.type ?? "worker",
      $description: task.description ?? null,
      $user_id: task.user_id ?? null,
      $branch: task.branch ?? null,
      $pr_url: task.pr_url ?? null,
      $provider: task.provider ?? DEFAULT_AGENT_ID,
      $model: task.model ?? null,
      $reasoning_effort: task.reasoning_effort ?? null,
      $parent_task_id: task.parent_task_id ?? null,
      $capabilities: task.capabilities ?? null,
    })
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow
  })
}

export function getTask(db: Database, id: string): Effect.Effect<TaskRow | null, DbError> {
  return dbTry(() => {
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null
  })
}

export function listTasks(db: Database, filter?: { status?: string; projectId?: string; search?: string; limit?: number; offset?: number }): Effect.Effect<TaskRow[], DbError> {
  return dbTry(() => {
    const conditions: string[] = []
    const params: Record<string, string> = {}
    if (filter?.status) {
      conditions.push("status = $status")
      params.$status = filter.status
    }
    if (filter?.projectId) {
      conditions.push("project_id = $project_id")
      params.$project_id = filter.projectId
    }
    if (filter?.search) {
      // Strip leading "#" so that "#123" matches pr_url paths like "/pull/123"
      const searchNormalized = filter.search.startsWith("#") ? filter.search.slice(1) : filter.search
      conditions.push("(title LIKE $search OR description LIKE $search OR branch LIKE $search OR pr_url LIKE $search)")
      params.$search = `%${searchNormalized}%`
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""
    // OFFSET requires LIMIT in SQLite — only apply offset when limit is also set
    const limitClause = filter?.limit !== undefined ? ` LIMIT ${Math.floor(filter.limit)}` : ""
    const offsetClause = filter?.limit !== undefined && filter?.offset !== undefined ? ` OFFSET ${Math.floor(filter.offset)}` : ""
    const orderBy = `ORDER BY CASE WHEN status IN ('created', 'provisioning', 'running') THEN 0 ELSE 1 END, created_at DESC`
    return db.prepare(`SELECT * FROM tasks${where} ${orderBy}${limitClause}${offsetClause}`).all(params) as TaskRow[]
  })
}

export function updateTask(
  db: Database,
  id: string,
  fields: Partial<Omit<TaskRow, "id">>,
  opts?: { skipUpdatedAt?: boolean },
): Effect.Effect<TaskRow | null, DbError> {
  return dbTry(() => {
    const keys = Object.keys(fields).filter((k) => k !== "id")
    if (keys.length === 0) return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null

    const sets = keys.map((k) => `${k} = $${k}`).join(", ")
    const params: Record<string, string | number | null> = { $id: id }
    for (const k of keys) {
      const val = fields[k as keyof typeof fields]
      params[`$${k}`] = val === undefined ? null : (val as string | number | null)
    }

    const updatedAtClause = opts?.skipUpdatedAt ? "" : ", updated_at = datetime('now')"
    db.prepare(`UPDATE tasks SET ${sets}${updatedAtClause} WHERE id = $id`).run(params)
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null
  })
}

export function updateTaskStatus(db: Database, id: string, status: string): Effect.Effect<TaskRow | null, DbError> {
  return updateTask(db, id, { status })
}

/** Update last_seen_at without bumping updated_at */
export function markTaskSeen(db: Database, id: string): Effect.Effect<TaskRow | null, DbError> {
  return updateTask(db, id, { last_seen_at: new Date().toISOString() }, { skipUpdatedAt: true })
}

/** Update last_result_at when the agent produces a final result (not narration/thinking) */
export function markTaskResult(db: Database, id: string): Effect.Effect<TaskRow | null, DbError> {
  return updateTask(db, id, { last_result_at: new Date().toISOString() }, { skipUpdatedAt: true })
}

export function getChildTasks(db: Database, parentTaskId: string): Effect.Effect<TaskRow[], DbError> {
  return dbTry(() => {
    return db.prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC").all(parentTaskId) as TaskRow[]
  })
}

export function countTasksByProject(db: Database, filter?: { status?: string; search?: string }): Effect.Effect<Record<string, number>, DbError> {
  return dbTry(() => {
    const conditions: string[] = []
    const params: Record<string, string> = {}
    if (filter?.status) {
      conditions.push("status = $status")
      params.$status = filter.status
    }
    if (filter?.search) {
      const searchNormalized = filter.search.startsWith("#") ? filter.search.slice(1) : filter.search
      conditions.push("(title LIKE $search OR description LIKE $search OR branch LIKE $search OR pr_url LIKE $search)")
      params.$search = `%${searchNormalized}%`
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""
    const rows = db.prepare(`SELECT project_id, COUNT(*) as count FROM tasks${where} GROUP BY project_id`).all(params) as { project_id: string; count: number }[]
    const counts: Record<string, number> = {}
    for (const row of rows) counts[row.project_id] = row.count
    return counts
  })
}

// --- Session Logs ---

export function insertSessionLog(
  db: Database,
  log: Pick<SessionLogRow, "task_id" | "role" | "content"> & { message_id?: string | null; images?: string | null; from_task_id?: string | null }
): Effect.Effect<SessionLogRow, DbError> {
  return dbTry(() => {
    const messageId = log.message_id?.trim() ? log.message_id : null
    const stmt = db.prepare(`
      INSERT ${messageId ? "OR IGNORE" : ""} INTO session_logs (task_id, role, message_id, content, images, from_task_id)
      VALUES ($task_id, $role, $message_id, $content, $images, $from_task_id)
    `)
    const result = stmt.run({
      $task_id: log.task_id,
      $role: log.role,
      $message_id: messageId,
      $content: log.content,
      $images: log.images ?? null,
      $from_task_id: log.from_task_id ?? null,
    })
    if (messageId && result.changes === 0) {
      return db.prepare(
        "SELECT * FROM session_logs WHERE task_id = ? AND role = ? AND message_id = ? ORDER BY id ASC LIMIT 1"
      ).get(log.task_id, log.role, messageId) as SessionLogRow
    }
    return db.prepare("SELECT * FROM session_logs WHERE id = ?").get(result.lastInsertRowid) as SessionLogRow
  })
}

export function getSessionLogs(db: Database, taskId: string): Effect.Effect<SessionLogRow[], DbError> {
  return dbTry(() => {
    return db.prepare("SELECT * FROM session_logs WHERE task_id = ? ORDER BY timestamp ASC").all(taskId) as SessionLogRow[]
  })
}

// --- Crons ---

export function createCron(
  db: Database,
  cron: Pick<CronRow, "id" | "project_id" | "title" | "cron"> &
    Partial<Pick<CronRow, "description" | "enabled" | "next_run_at" | "task_defaults">>
): Effect.Effect<CronRow, DbError> {
  return dbTry(() => {
    db.prepare(`
      INSERT INTO crons (id, project_id, title, description, cron, enabled, next_run_at, task_defaults)
      VALUES ($id, $project_id, $title, $description, $cron, $enabled, $next_run_at, $task_defaults)
    `).run({
      $id: cron.id,
      $project_id: cron.project_id,
      $title: cron.title,
      $description: cron.description ?? null,
      $cron: cron.cron,
      $enabled: cron.enabled ?? 1,
      $next_run_at: cron.next_run_at ?? null,
      $task_defaults: cron.task_defaults ?? null,
    })
    return db.prepare("SELECT * FROM crons WHERE id = ?").get(cron.id) as CronRow
  })
}

export function getCron(db: Database, id: string): Effect.Effect<CronRow | null, DbError> {
  return dbTry(() => db.prepare("SELECT * FROM crons WHERE id = ?").get(id) as CronRow | null)
}

export function listCrons(db: Database, filter?: { projectId?: string }): Effect.Effect<CronRow[], DbError> {
  return dbTry(() => {
    if (filter?.projectId) {
      return db.prepare("SELECT * FROM crons WHERE project_id = $project_id ORDER BY created_at DESC").all({ $project_id: filter.projectId }) as CronRow[]
    }
    return db.prepare("SELECT * FROM crons ORDER BY created_at DESC").all() as CronRow[]
  })
}

export function updateCron(
  db: Database,
  id: string,
  fields: Partial<Omit<CronRow, "id">>,
): Effect.Effect<CronRow | null, DbError> {
  return dbTry(() => {
    const keys = Object.keys(fields).filter((k) => k !== "id")
    if (keys.length === 0) return db.prepare("SELECT * FROM crons WHERE id = ?").get(id) as CronRow | null
    const sets = keys.map((k) => `${k} = $${k}`).join(", ")
    const params: Record<string, string | number | null> = { $id: id }
    for (const k of keys) {
      const val = fields[k as keyof typeof fields]
      params[`$${k}`] = val === undefined ? null : (val as string | number | null)
    }
    db.prepare(`UPDATE crons SET ${sets}, updated_at = datetime('now') WHERE id = $id`).run(params)
    return db.prepare("SELECT * FROM crons WHERE id = ?").get(id) as CronRow | null
  })
}

export function deleteCron(db: Database, id: string): Effect.Effect<void, DbError> {
  return dbTry(() => {
    db.prepare("DELETE FROM crons WHERE id = ?").run(id)
  })
}

export function getDueCrons(db: Database): Effect.Effect<CronRow[], DbError> {
  return dbTry(() => {
    return db.prepare(
      `SELECT * FROM crons WHERE enabled = 1 AND next_run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).all() as CronRow[]
  })
}

export function hasActiveCronTask(db: Database, cronId: string): Effect.Effect<boolean, DbError> {
  return dbTry(() => {
    const row = db.prepare(
      `SELECT 1 FROM tasks WHERE source = 'cron' AND source_id = $source_id AND status NOT IN ('done', 'failed', 'cancelled') LIMIT 1`
    ).get({ $source_id: `cron:${cronId}` })
    return row != null
  })
}

export function getTasksByIds(db: Database, ids: string[]): Effect.Effect<TaskRow[], DbError> {
  return dbTry(() => {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => "?").join(",")
    return db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders})`).all(...ids) as TaskRow[]
  })
}

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"])

export function deleteTask(db: Database, id: string): Effect.Effect<void, DbError> {
  return dbTry(() => {
    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string } | null
    if (!task) throw new Error(`Task ${id} not found`)
    if (!TERMINAL_STATUSES.has(task.status)) {
      throw new Error(`Task ${id} is not terminal (status: ${task.status})`)
    }
    db.prepare("DELETE FROM activity_log WHERE task_id = ?").run(id)
    db.prepare("DELETE FROM session_logs WHERE task_id = ?").run(id)
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
  })
}
