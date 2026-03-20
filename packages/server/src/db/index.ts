import { Database } from "bun:sqlite"
import { join } from "path"
import { TANGERINE_HOME } from "../config"
import { SCHEMA } from "./schema"

let instance: Database | null = null

/** Returns a singleton DB connection, creating it if needed. Pass ":memory:" for tests. */
export function getDb(path?: string): Database {
  if (instance) return instance

  const dbPath = path ?? join(TANGERINE_HOME, "tangerine.db")
  const db = new Database(dbPath)

  // WAL mode for better concurrent read performance
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")

  db.exec(SCHEMA)

  // Migrations for existing databases
  try { db.exec("ALTER TABLE tasks ADD COLUMN model TEXT") } catch {}

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
