import { Database } from "bun:sqlite"
import { SCHEMA } from "../db/schema"
import type { Task } from "@tangerine/shared"

/** Create an in-memory SQLite DB with schema applied */
export function createTestDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA)
  return db
}

/** Build a Task object (camelCase, matching @tangerine/shared) */
export function makeTask(overrides?: Partial<Task>): Task {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    projectId: "test",
    source: "manual",
    sourceId: null,
    sourceUrl: null,
    title: "Test task",
    description: null,
    status: "created",
    type: "code",
    provider: "opencode",
    model: null,
    reasoningEffort: null,
    branch: null,
    worktreePath: null,
    prUrl: null,
    reviewPrNumber: null,
    reviewTaskId: null,
    userId: null,
    agentSessionId: null,
    agentPid: null,
    previewUrl: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    lastSeenAt: null,
    ...overrides,
  }
}
