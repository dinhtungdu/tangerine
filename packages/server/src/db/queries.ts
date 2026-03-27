import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import type { TaskRow, SessionLogRow } from "./types"
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
  task: Pick<TaskRow, "id" | "project_id" | "source" | "repo_url" | "title"> &
    Partial<Pick<TaskRow, "source_id" | "source_url" | "description" | "user_id" | "branch" | "provider" | "model" | "reasoning_effort">>
): Effect.Effect<TaskRow, DbError> {
  return dbTry(() => {
    const stmt = db.prepare(`
      INSERT INTO tasks (id, project_id, source, source_id, source_url, repo_url, title, description, user_id, branch, provider, model, reasoning_effort)
      VALUES ($id, $project_id, $source, $source_id, $source_url, $repo_url, $title, $description, $user_id, $branch, $provider, $model, $reasoning_effort)
    `)
    stmt.run({
      $id: task.id,
      $project_id: task.project_id,
      $source: task.source,
      $source_id: task.source_id ?? null,
      $source_url: task.source_url ?? null,
      $repo_url: task.repo_url,
      $title: task.title,
      $description: task.description ?? null,
      $user_id: task.user_id ?? null,
      $branch: task.branch ?? null,
      $provider: task.provider ?? "opencode",
      $model: task.model ?? null,
      $reasoning_effort: task.reasoning_effort ?? null,
    })
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow
  })
}

export function getTask(db: Database, id: string): Effect.Effect<TaskRow | null, DbError> {
  return dbTry(() => {
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null
  })
}

export function listTasks(db: Database, filter?: { status?: string; projectId?: string; search?: string }): Effect.Effect<TaskRow[], DbError> {
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
      conditions.push("(title LIKE $search OR description LIKE $search)")
      params.$search = `%${filter.search}%`
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""
    return db.prepare(`SELECT * FROM tasks${where} ORDER BY created_at DESC`).all(params) as TaskRow[]
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

// --- Session Logs ---

export function insertSessionLog(
  db: Database,
  log: Pick<SessionLogRow, "task_id" | "role" | "content"> & { images?: string | null }
): Effect.Effect<SessionLogRow, DbError> {
  return dbTry(() => {
    const stmt = db.prepare(`
      INSERT INTO session_logs (task_id, role, content, images)
      VALUES ($task_id, $role, $content, $images)
    `)
    const result = stmt.run({
      $task_id: log.task_id,
      $role: log.role,
      $content: log.content,
      $images: log.images ?? null,
    })
    return db.prepare("SELECT * FROM session_logs WHERE id = ?").get(result.lastInsertRowid) as SessionLogRow
  })
}

export function getSessionLogs(db: Database, taskId: string): Effect.Effect<SessionLogRow[], DbError> {
  return dbTry(() => {
    return db.prepare("SELECT * FROM session_logs WHERE task_id = ? ORDER BY timestamp ASC").all(taskId) as SessionLogRow[]
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
