import { Database } from "bun:sqlite"
import { join } from "path"
import { TANGERINE_HOME } from "../config"
import { SCHEMA } from "./schema"

let instance: Database | null = null

/**
 * Auto-migrate: compare columns defined in SCHEMA with what exists in the DB.
 * Adds missing columns via ALTER TABLE. Handles schema evolution without manual migrations.
 */
export function autoMigrate(db: Database): void {
  // Parse CREATE TABLE statements from schema to find expected columns
  const tableRegex = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\);/g
  let match: RegExpExecArray | null

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

    // Parse column definitions from schema (skip constraints, indexes)
    const lines = body.split(",").map((l) => l.trim())
    for (const line of lines) {
      // Match column definitions: "column_name TYPE ..." but not "FOREIGN KEY", "PRIMARY KEY", "CREATE INDEX"
      const colMatch = line.match(/^(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)(.*)$/i)
      if (!colMatch) continue

      const colName = colMatch[1]!
      const colType = colMatch[2]!
      const rest = colMatch[3]!.trim()

      if (existingCols.has(colName)) continue

      // Build ALTER TABLE — include DEFAULT if present
      const defaultMatch = rest.match(/DEFAULT\s+(.+?)(?:\s*,|\s*$)/i)
      const defaultClause = defaultMatch ? ` DEFAULT ${defaultMatch[1]}` : ""
      const notNull = /NOT NULL/i.test(rest) && defaultClause ? " NOT NULL" : ""

      try {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colType}${notNull}${defaultClause}`)
      } catch {
        // Column may have been added concurrently
      }
    }
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
export type { VmRow, TaskRow, SessionLogRow, ImageRow } from "./types"
export {
  createTask,
  getTask,
  listTasks,
  updateTask,
  updateTaskStatus,
  createVm,
  getVm,
  listVms,
  updateVm,
  updateVmStatus,
  getVmByProject,
  insertSessionLog,
  getSessionLogs,
  createImage,
  getImage,
  listImages,
  pruneOldImages,
} from "./queries"
