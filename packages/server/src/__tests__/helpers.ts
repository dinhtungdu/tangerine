import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { SCHEMA } from "../db/schema"
import type { Provider, Instance, CreateInstanceOptions } from "../vm/providers/types"
import type { Task } from "@tangerine/shared"

/** Create an in-memory SQLite DB with schema applied */
export function createTestDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA)
  return db
}

/** Create a mock Provider that tracks instances in memory and returns Effect types */
export function createMockProvider(): Provider & { instances: Map<string, Instance> } {
  const instances = new Map<string, Instance>()

  return {
    instances,

    createInstance(opts: CreateInstanceOptions) {
      const id = opts.label ?? `inst-${Date.now()}`
      const instance: Instance = {
        id,
        label: opts.label ?? id,
        ip: "10.0.0.1",
        status: "active",
        region: opts.region,
        plan: opts.plan,
        snapshotId: opts.snapshotId,
        createdAt: new Date().toISOString(),
        sshPort: 22,
      }
      instances.set(id, instance)
      return Effect.succeed(instance)
    },

    startInstance(id: string) {
      return Effect.sync(() => {
        const inst = instances.get(id)
        if (inst) inst.status = "active"
      })
    },

    stopInstance(id: string) {
      return Effect.sync(() => {
        const inst = instances.get(id)
        if (inst) inst.status = "stopped"
      })
    },

    destroyInstance(id: string) {
      return Effect.sync(() => {
        instances.delete(id)
      })
    },

    getInstance(id: string) {
      return Effect.sync(() => {
        const inst = instances.get(id)
        if (!inst) throw new Error(`Instance ${id} not found`)
        return inst
      })
    },

    listInstances() {
      return Effect.succeed([...instances.values()])
    },

    waitForReady(id: string) {
      return Effect.sync(() => {
        const inst = instances.get(id)
        if (!inst) throw new Error(`Instance ${id} not found`)
        inst.status = "active"
        return inst
      })
    },

    createSnapshot(_instanceId: string, description: string) {
      return Effect.succeed({
        id: `snap-${Date.now()}`,
        description,
        status: "complete" as const,
        size: 1024,
        createdAt: new Date().toISOString(),
      })
    },

    listSnapshots() {
      return Effect.succeed([])
    },

    getSnapshot(id: string) {
      return Effect.succeed({
        id,
        description: "test",
        status: "complete" as const,
        size: 1024,
        createdAt: new Date().toISOString(),
      })
    },

    deleteSnapshot() {
      return Effect.succeed(undefined as void)
    },

    waitForSnapshot(id: string) {
      return Effect.succeed({
        id,
        description: "test",
        status: "complete" as const,
        size: 1024,
        createdAt: new Date().toISOString(),
      })
    },
  }
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
    provider: "opencode",
    vmId: null,
    branch: null,
    worktreePath: null,
    prUrl: null,
    userId: null,
    agentSessionId: null,
    agentPort: null,
    previewPort: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}
