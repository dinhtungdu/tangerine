import { describe, expect, test } from "bun:test"
import { mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { tangerineConfigSchema } from "@tangerine/shared"
import type { TangerineConfig } from "@tangerine/shared"
import { createTestDb } from "./helpers"
import { migrateProjects } from "../cli/migrate"
import type { LocalExec } from "../tasks/worktree-pool"

const mockExec: LocalExec = () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 })

function makeConfig(workspace: string): TangerineConfig {
  return tangerineConfigSchema.parse({
    workspace,
    projects: [
      {
        name: "proj-1",
        repo: "https://example.com/proj-1.git",
        setup: "bun install",
        defaultBranch: "main",
      },
    ],
  })
}

function makeOldLayout(workspace: string): { projectDir: string; oldRepoPath: string; newRepoPath: string } {
  const projectDir = join(workspace, "proj-1")
  const oldRepoPath = join(projectDir, "0")
  mkdirSync(join(oldRepoPath, ".git"), { recursive: true })
  mkdirSync(join(projectDir, "1", ".git"), { recursive: true })
  return { projectDir, oldRepoPath, newRepoPath: projectDir }
}

describe("migrateProjects", () => {
  test("moves old numbered layout to sibling layout and recreates slots", async () => {
    const root = mkdtempSync(join(tmpdir(), "tangerine-migrate-"))
    try {
      const config = makeConfig(root)
      const { oldRepoPath, newRepoPath } = makeOldLayout(root)
      const db = createTestDb()
      db.prepare("INSERT INTO tasks (id, project_id, source, title, status, worktree_path) VALUES (?, ?, ?, ?, ?, ?)")
        .run("done-task", "proj-1", "manual", "Done task", "done", join(root, "proj-1", "1"))
      db.prepare("INSERT INTO worktree_slots (id, project_id, path, status) VALUES (?, ?, ?, ?)")
        .run("proj-1-slot-0", "proj-1", oldRepoPath, "available")
      db.prepare("INSERT INTO worktree_slots (id, project_id, path, status, task_id) VALUES (?, ?, ?, ?, ?)")
        .run("proj-1-slot-1", "proj-1", join(root, "proj-1", "1"), "bound", "done-task")

      const summary = await migrateProjects({ db, config, exec: mockExec, poolSize: 1 })

      expect(summary.results).toEqual([
        {
          projectId: "proj-1",
          status: "migrated",
          repoPath: newRepoPath,
          oldRepoPath,
          staleSlotsReleased: 1,
        },
      ])
      expect(existsSync(join(newRepoPath, ".git"))).toBe(true)
      expect(existsSync(join(newRepoPath, "0"))).toBe(false)
      const migratedTask = db.prepare("SELECT worktree_path FROM tasks WHERE id = ?").get("done-task") as { worktree_path: string | null }
      expect(migratedTask.worktree_path).toBeNull()
      const slots = db.prepare("SELECT id, path, status, task_id FROM worktree_slots ORDER BY id").all() as Array<{
        id: string
        path: string
        status: string
        task_id: string | null
      }>
      expect(slots).toEqual([
        { id: "proj-1-slot-0", path: newRepoPath, status: "available", task_id: null },
        { id: "proj-1-slot-1", path: `${newRepoPath}--1`, status: "available", task_id: null },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("blocks migration when a running task owns an old slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "tangerine-migrate-blocked-"))
    try {
      const config = makeConfig(root)
      const { oldRepoPath, newRepoPath } = makeOldLayout(root)
      const db = createTestDb()
      db.prepare("INSERT INTO tasks (id, project_id, source, title, status) VALUES (?, ?, ?, ?, ?)")
        .run("running-task", "proj-1", "manual", "Running task", "running")
      db.prepare("INSERT INTO worktree_slots (id, project_id, path, status) VALUES (?, ?, ?, ?)")
        .run("proj-1-slot-0", "proj-1", oldRepoPath, "available")
      db.prepare("INSERT INTO worktree_slots (id, project_id, path, status, task_id) VALUES (?, ?, ?, ?, ?)")
        .run("proj-1-slot-1", "proj-1", join(root, "proj-1", "1"), "bound", "running-task")

      const summary = await migrateProjects({ db, config, exec: mockExec, poolSize: 1 })

      expect(summary.results).toEqual([
        {
          projectId: "proj-1",
          status: "blocked",
          repoPath: newRepoPath,
          oldRepoPath,
          activeReferences: 1,
          staleSlotsReleased: 0,
        },
      ])
      expect(existsSync(join(oldRepoPath, ".git"))).toBe(true)
      const slot0 = db.prepare("SELECT path FROM worktree_slots WHERE id = ?").get("proj-1-slot-0") as { path: string }
      expect(slot0.path).toBe(oldRepoPath)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("blocks migration when an active task references old slot 0 without a bound slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "tangerine-migrate-active-path-"))
    try {
      const config = makeConfig(root)
      const { oldRepoPath, newRepoPath } = makeOldLayout(root)
      const db = createTestDb()
      db.prepare("INSERT INTO tasks (id, project_id, source, title, status, worktree_path) VALUES (?, ?, ?, ?, ?, ?)")
        .run("running-runner", "proj-1", "manual", "Running runner", "running", oldRepoPath)
      db.prepare("INSERT INTO worktree_slots (id, project_id, path, status) VALUES (?, ?, ?, ?)")
        .run("proj-1-slot-0", "proj-1", oldRepoPath, "available")

      const summary = await migrateProjects({ db, config, exec: mockExec, poolSize: 1 })

      expect(summary.results).toEqual([
        {
          projectId: "proj-1",
          status: "blocked",
          repoPath: newRepoPath,
          oldRepoPath,
          activeReferences: 1,
          staleSlotsReleased: 0,
        },
      ])
      expect(existsSync(join(oldRepoPath, ".git"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
