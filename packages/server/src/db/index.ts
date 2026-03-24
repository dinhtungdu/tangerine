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

/** Returns a singleton DB connection, creating it if needed. Pass ":memory:" for tests. */
export function getDb(path?: string): Database {
  if (instance) return instance

  const dbPath = path ?? join(TANGERINE_HOME, "tangerine.db")
  const db = new Database(dbPath)

  // WAL mode for better concurrent read performance
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")

  // autoMigrate first — adds missing columns to existing tables so that
  // CREATE INDEX statements in SCHEMA don't fail on new columns
  autoMigrate(db)
  db.exec(SCHEMA)

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
export type { TaskRow, SessionLogRow } from "./types"
export {
  createTask,
  getTask,
  listTasks,
  updateTask,
  updateTaskStatus,
  insertSessionLog,
  getSessionLogs,
} from "./queries"
