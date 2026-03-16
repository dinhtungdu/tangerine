import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import type { VmRow, TaskRow, SessionLogRow, ImageRow } from "./types"
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
    Partial<Pick<TaskRow, "source_id" | "source_url" | "description" | "user_id" | "branch">>
): Effect.Effect<TaskRow, DbError> {
  return dbTry(() => {
    const stmt = db.prepare(`
      INSERT INTO tasks (id, project_id, source, source_id, source_url, repo_url, title, description, user_id, branch)
      VALUES ($id, $project_id, $source, $source_id, $source_url, $repo_url, $title, $description, $user_id, $branch)
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
    })
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow
  })
}

export function getTask(db: Database, id: string): Effect.Effect<TaskRow | null, DbError> {
  return dbTry(() => {
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null
  })
}

export function listTasks(db: Database, filter?: { status?: string; projectId?: string }): Effect.Effect<TaskRow[], DbError> {
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
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""
    return db.prepare(`SELECT * FROM tasks${where} ORDER BY created_at DESC`).all(params) as TaskRow[]
  })
}

export function updateTask(db: Database, id: string, fields: Partial<Omit<TaskRow, "id">>): Effect.Effect<TaskRow | null, DbError> {
  return dbTry(() => {
    const keys = Object.keys(fields).filter((k) => k !== "id")
    if (keys.length === 0) return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null

    const sets = keys.map((k) => `${k} = $${k}`).join(", ")
    const params: Record<string, string | number | null> = { $id: id }
    for (const k of keys) {
      const val = fields[k as keyof typeof fields]
      params[`$${k}`] = val === undefined ? null : (val as string | number | null)
    }

    db.prepare(`UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = $id`).run(params)
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null
  })
}

export function updateTaskStatus(db: Database, id: string, status: string): Effect.Effect<TaskRow | null, DbError> {
  return updateTask(db, id, { status })
}

// --- VMs ---

export function createVm(
  db: Database,
  vm: Pick<VmRow, "id" | "label" | "provider" | "snapshot_id" | "region" | "plan"> &
    Partial<Pick<VmRow, "ip" | "ssh_port" | "status">>
): Effect.Effect<VmRow, DbError> {
  return dbTry(() => {
    const stmt = db.prepare(`
      INSERT INTO vms (id, label, provider, ip, ssh_port, status, snapshot_id, region, plan)
      VALUES ($id, $label, $provider, $ip, $ssh_port, $status, $snapshot_id, $region, $plan)
    `)
    stmt.run({
      $id: vm.id,
      $label: vm.label,
      $provider: vm.provider,
      $ip: vm.ip ?? null,
      $ssh_port: vm.ssh_port ?? null,
      $status: vm.status ?? "provisioning",
      $snapshot_id: vm.snapshot_id,
      $region: vm.region,
      $plan: vm.plan,
    })
    return db.prepare("SELECT * FROM vms WHERE id = ?").get(vm.id) as VmRow
  })
}

export function getVm(db: Database, id: string): Effect.Effect<VmRow | null, DbError> {
  return dbTry(() => {
    return db.prepare("SELECT * FROM vms WHERE id = ?").get(id) as VmRow | null
  })
}

export function listVms(db: Database, status?: string): Effect.Effect<VmRow[], DbError> {
  return dbTry(() => {
    if (status) {
      return db.prepare("SELECT * FROM vms WHERE status = ? ORDER BY created_at DESC").all(status) as VmRow[]
    }
    return db.prepare("SELECT * FROM vms ORDER BY created_at DESC").all() as VmRow[]
  })
}

export function updateVm(db: Database, id: string, fields: Partial<Omit<VmRow, "id">>): Effect.Effect<VmRow | null, DbError> {
  return dbTry(() => {
    const keys = Object.keys(fields).filter((k) => k !== "id")
    if (keys.length === 0) return db.prepare("SELECT * FROM vms WHERE id = ?").get(id) as VmRow | null

    const sets = keys.map((k) => `${k} = $${k}`).join(", ")
    const params: Record<string, string | number | null> = { $id: id }
    for (const k of keys) {
      const val = fields[k as keyof typeof fields]
      params[`$${k}`] = val === undefined ? null : (val as string | number | null)
    }

    db.prepare(`UPDATE vms SET ${sets}, updated_at = datetime('now') WHERE id = $id`).run(params)
    return db.prepare("SELECT * FROM vms WHERE id = ?").get(id) as VmRow | null
  })
}

export function updateVmStatus(db: Database, id: string, status: string): Effect.Effect<VmRow | null, DbError> {
  return updateVm(db, id, { status })
}

export function assignVm(db: Database, vmId: string, taskId: string): Effect.Effect<VmRow | null, DbError> {
  return updateVm(db, vmId, { status: "assigned", task_id: taskId, idle_since: null })
}

export function releaseVm(db: Database, vmId: string): Effect.Effect<VmRow | null, DbError> {
  return updateVm(db, vmId, {
    status: "ready",
    task_id: null,
    idle_since: new Date().toISOString(),
  })
}

// --- Session Logs ---

export function insertSessionLog(
  db: Database,
  log: Pick<SessionLogRow, "task_id" | "role" | "content">
): Effect.Effect<SessionLogRow, DbError> {
  return dbTry(() => {
    const stmt = db.prepare(`
      INSERT INTO session_logs (task_id, role, content)
      VALUES ($task_id, $role, $content)
    `)
    const result = stmt.run({
      $task_id: log.task_id,
      $role: log.role,
      $content: log.content,
    })
    return db.prepare("SELECT * FROM session_logs WHERE id = ?").get(result.lastInsertRowid) as SessionLogRow
  })
}

export function getSessionLogs(db: Database, taskId: string): Effect.Effect<SessionLogRow[], DbError> {
  return dbTry(() => {
    return db.prepare("SELECT * FROM session_logs WHERE task_id = ? ORDER BY timestamp ASC").all(taskId) as SessionLogRow[]
  })
}

// --- Images ---

export function createImage(
  db: Database,
  image: Pick<ImageRow, "id" | "name" | "provider" | "snapshot_id">
): Effect.Effect<ImageRow, DbError> {
  return dbTry(() => {
    const stmt = db.prepare(`
      INSERT INTO images (id, name, provider, snapshot_id)
      VALUES ($id, $name, $provider, $snapshot_id)
    `)
    stmt.run({
      $id: image.id,
      $name: image.name,
      $provider: image.provider,
      $snapshot_id: image.snapshot_id,
    })
    return db.prepare("SELECT * FROM images WHERE id = ?").get(image.id) as ImageRow
  })
}

export function getImage(db: Database, id: string): Effect.Effect<ImageRow | null, DbError> {
  return dbTry(() => {
    return db.prepare("SELECT * FROM images WHERE id = ?").get(id) as ImageRow | null
  })
}

export function listImages(db: Database): Effect.Effect<ImageRow[], DbError> {
  return dbTry(() => {
    return db.prepare("SELECT * FROM images ORDER BY created_at DESC").all() as ImageRow[]
  })
}
