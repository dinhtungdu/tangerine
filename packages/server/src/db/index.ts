import { Database } from "bun:sqlite"
import { join } from "path"
import { TANGERINE_HOME } from "../config"
import { SCHEMA } from "./schema"

let instance: Database | null = null

/**
 * Parse expected columns from a CREATE TABLE body.
 * Returns array of { name, type, rest } for each column definition.
 * Skips constraints (FOREIGN KEY, PRIMARY KEY, UNIQUE, CHECK).
 */
function parseColumns(tableBody: string): { name: string; type: string; rest: string }[] {
  const columns: { name: string; type: string; rest: string }[] = []

  // Split by commas, but respect parenthesized expressions (e.g. DEFAULT (datetime('now')))
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const ch of tableBody) {
    if (ch === "(") depth++
    else if (ch === ")") depth--
    if (ch === "," && depth === 0) {
      parts.push(current.trim())
      current = ""
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current.trim())

  for (const part of parts) {
    // Skip constraints
    if (/^\s*(FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(part)) continue
    // Match: column_name TYPE [rest...]
    const m = part.match(/^(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)\b(.*)$/is)
    if (m) columns.push({ name: m[1]!, type: m[2]!, rest: m[3]!.trim() })
  }

  return columns
}

/**
 * Auto-migrate: compare columns defined in SCHEMA with what exists in the DB.
 * Adds missing columns via ALTER TABLE. Handles schema evolution without manual migrations.
 */
export function autoMigrate(db: Database): void {
  const tableRegex = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\);/g
  let match: RegExpExecArray | null
  const migrated: string[] = []

  while ((match = tableRegex.exec(SCHEMA)) !== null) {
    const tableName = match[1]!
    const body = match[2]!

    // Get existing columns from DB
    const existingCols = new Set<string>()
    try {
      const info = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[]
      for (const col of info) existingCols.add(col.name)
    } catch {
      continue // table doesn't exist yet, CREATE TABLE will handle it
    }

    if (existingCols.size === 0) continue

    for (const col of parseColumns(body)) {
      if (existingCols.has(col.name)) continue

      // Build ALTER TABLE — include DEFAULT if present in the schema definition
      const defaultMatch = col.rest.match(/DEFAULT\s+(\([^)]+\)|'[^']*'|\S+)/i)
      const defaultClause = defaultMatch ? ` DEFAULT ${defaultMatch[1]}` : ""
      // NOT NULL only safe if we have a default (can't add NOT NULL to existing rows without one)
      const notNull = /NOT NULL/i.test(col.rest) && defaultClause ? " NOT NULL" : ""

      try {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${col.type}${notNull}${defaultClause}`)
        migrated.push(`${tableName}.${col.name}`)
      } catch {
        // Column may have been added concurrently
      }
    }
  }

  if (migrated.length > 0) {
    // Log to stderr since the logger may not be initialized yet
    console.error(`[db] Auto-migrated ${migrated.length} column(s): ${migrated.join(", ")}`)
  }
}

/**
 * v0→v1 schema migration for worktree_slots.
 * The v0 schema had `vm_id TEXT NOT NULL` which blocks v1 INSERTs (no vm_id provided).
 * INSERT OR IGNORE silently drops the row, so initPool creates no slots and acquireSlot fails.
 * Slots are transient — safe to drop and recreate.
 */
function migrateWorktreeSlots(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(worktree_slots)").all() as { name: string; notnull: number }[]
  const hasVmIdNotNull = cols.some((c) => c.name === "vm_id" && c.notnull === 1)
  if (!hasVmIdNotNull) return

  db.exec("DROP TABLE IF EXISTS worktree_slots")
  console.error("[db] Migrated worktree_slots: dropped v0 table (vm_id NOT NULL → project_id)")
}

/**
 * Drop the redundant repo_url column from tasks.
 * Tasks now derive repo URL from their project config via project_id.
 */
function dropRepoUrlColumn(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  if (!cols.some((c) => c.name === "repo_url")) return

  db.exec("ALTER TABLE tasks DROP COLUMN repo_url")
  console.error("[db] Migrated tasks: dropped redundant repo_url column")
}

/**
 * Drop the checkpoints table and branched_from_checkpoint_id column.
 * Checkpoint/branching feature was removed — clean up legacy data to prevent FK errors.
 */
function dropCheckpointsTable(db: Database): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'").all() as { name: string }[]
  if (tables.length === 0) return

  db.exec("DROP TABLE IF EXISTS checkpoints")
  console.error("[db] Migrated: dropped legacy checkpoints table")

  // Also drop the branched_from_checkpoint_id column if present
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  if (cols.some((c) => c.name === "branched_from_checkpoint_id")) {
    db.exec("ALTER TABLE tasks DROP COLUMN branched_from_checkpoint_id")
    console.error("[db] Migrated tasks: dropped branched_from_checkpoint_id column")
  }
}

/**
 * Drop legacy session_logs table — agent stores session history in files.
 */
function dropSessionLogsTable(db: Database): void {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='session_logs'"
  ).all() as { name: string }[]
  if (tables.length === 0) return

  db.exec("DROP TABLE IF EXISTS session_logs")
  console.error("[db] Migrated: dropped legacy session_logs table")
}

/**
 * Drop stream_events table — agent stores session history in files, not DB.
 */
function dropStreamEventsTable(db: Database): void {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='stream_events'"
  ).all() as { name: string }[]
  if (tables.length === 0) return

  db.exec("DROP TABLE IF EXISTS stream_events")
  console.error("[db] Migrated: dropped stream_events table (agent stores history in files)")
}

/**
 * Drop unused input_tokens and output_tokens columns from tasks.
 * We now only track context_tokens for display.
 */
function dropCumulativeTokenColumns(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  const dropped: string[] = []
  if (cols.some((c) => c.name === "input_tokens")) {
    db.exec("ALTER TABLE tasks DROP COLUMN input_tokens")
    dropped.push("input_tokens")
  }
  if (cols.some((c) => c.name === "output_tokens")) {
    db.exec("ALTER TABLE tasks DROP COLUMN output_tokens")
    dropped.push("output_tokens")
  }
  if (dropped.length > 0) {
    console.error(`[db] Migrated tasks: dropped ${dropped.join(", ")} columns`)
  }
}

/** Returns a singleton DB connection, creating it if needed. Pass ":memory:" for tests.
 *  Respects TANGERINE_DB env var for path override. */
export function getDb(path?: string): Database {
  if (instance) return instance

  const dbPath = path ?? process.env["TANGERINE_DB"] ?? join(TANGERINE_HOME, "tangerine.db")
  const db = new Database(dbPath)

  // WAL mode for better concurrent read performance
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")

  // v0→v1 migration: worktree_slots changed vm_id→project_id.
  // The old schema has vm_id TEXT NOT NULL which silently blocks v1 INSERTs.
  // Since slots are transient (rebuilt by initPool), we can safely recreate the table.
  migrateWorktreeSlots(db)

  // Drop legacy checkpoints table/column before autoMigrate (feature removed)
  dropCheckpointsTable(db)

  // autoMigrate first — adds missing columns to existing tables so that
  // CREATE INDEX statements in SCHEMA don't fail on new columns
  autoMigrate(db)
  db.exec(SCHEMA)

  // Drop redundant repo_url column — tasks use project_id to look up repo URL
  dropRepoUrlColumn(db)

  // Drop unused cumulative token columns — now only track context_tokens
  dropCumulativeTokenColumns(db)

  // Drop legacy session tables — agent stores history in files
  dropSessionLogsTable(db)
  dropStreamEventsTable(db)

  instance = db
  return db
}

/** Reset singleton — only use in tests to get a fresh DB per test */
export function resetDb(): void {
  if (instance) {
    instance.close()
    instance = null
  }
}

export { SCHEMA } from "./schema"
export type { TaskRow, CronRow } from "./types"
export {
  createTask,
  getTask,
  listTasks,
  updateTask,
  updateTaskStatus,
  createCron,
  getCron,
  listCrons,
  updateCron,
  deleteCron,
  getDueCrons,
  hasActiveCronTask,
  getChildTasks,
} from "./queries"
