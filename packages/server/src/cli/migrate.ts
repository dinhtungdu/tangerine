import type { Database } from "bun:sqlite"
import { Effect } from "effect"
import type { TangerineConfig } from "@tangerine/shared"
import { getRepoDir, loadConfig } from "../config.ts"
import { getDb } from "../db/index.ts"
import {
  initPool,
  localExec,
  migrateWorktreeLayout,
  planWorktreeLayoutMigration,
  reconcileStaleSlots,
  type LocalExec,
} from "../tasks/worktree-pool.ts"
import { parseArgs } from "./helpers.ts"

export type MigrateProjectResult =
  | { projectId: string; status: "current"; repoPath: string; staleSlotsReleased: number }
  | { projectId: string; status: "migrated"; repoPath: string; oldRepoPath: string; staleSlotsReleased: number }
  | { projectId: string; status: "blocked"; repoPath: string; oldRepoPath: string; activeReferences: number; staleSlotsReleased: number }

export interface MigrateSummary {
  results: MigrateProjectResult[]
}

interface MigrateProjectsOptions {
  db: Database
  config: TangerineConfig
  projectId?: string
  exec?: LocalExec
  poolSize?: number
}

function getTaskStatus(db: Database, taskId: string): Effect.Effect<{ status: string } | null, Error> {
  return Effect.try({
    try: () => db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | null,
    catch: (e) => new Error(`Failed to read task ${taskId}: ${e}`),
  })
}

export async function migrateProjects(options: MigrateProjectsOptions): Promise<MigrateSummary> {
  const exec = options.exec ?? localExec
  const selectedProjects = options.projectId
    ? options.config.projects.filter((project) => project.name === options.projectId)
    : options.config.projects

  if (options.projectId && selectedProjects.length === 0) {
    throw new Error(`Unknown project: ${options.projectId}`)
  }

  const results: MigrateProjectResult[] = []

  for (const project of selectedProjects) {
    const projectId = project.name
    const repoPath = getRepoDir(options.config, projectId)
    const staleSlotsReleased = await Effect.runPromise(
      reconcileStaleSlots(options.db, projectId, (taskId) => getTaskStatus(options.db, taskId)),
    )
    const plan = await Effect.runPromise(planWorktreeLayoutMigration(options.db, projectId, repoPath))

    if (plan.status === "current") {
      results.push({ projectId, status: "current", repoPath, staleSlotsReleased })
      continue
    }

    if (plan.status === "blocked") {
      results.push({
        projectId,
        status: "blocked",
        repoPath,
        oldRepoPath: plan.oldRepoPath,
        activeReferences: plan.activeReferences,
        staleSlotsReleased,
      })
      continue
    }

    const migrated = await Effect.runPromise(migrateWorktreeLayout(options.db, projectId, repoPath, exec))
    if (!migrated) {
      results.push({ projectId, status: "current", repoPath, staleSlotsReleased })
      continue
    }

    await Effect.runPromise(initPool(options.db, projectId, exec, repoPath, options.poolSize))
    results.push({
      projectId,
      status: "migrated",
      repoPath,
      oldRepoPath: plan.oldRepoPath,
      staleSlotsReleased,
    })
  }

  return { results }
}

export async function runMigrate(argv: string[]): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    printMigrateHelp()
    process.exit(0)
  }

  const parsed = parseArgs(argv, {
    project: { alias: "p" },
  })
  const appConfig = loadConfig()
  const db = getDb()
  const summary = await migrateProjects({
    db,
    config: appConfig.config,
    projectId: parsed.flags["project"],
  })

  printMigrateSummary(summary)
  if (summary.results.some((result) => result.status === "blocked")) {
    process.exit(1)
  }
}

function printMigrateHelp(): void {
  console.log(`
Usage: tangerine migrate [options]

Migrate project worktree directories from the old numbered layout:
  {workspace}/{project}/0, /1, /2

to the current sibling layout:
  {workspace}/{project}, {project}--1, {project}--2

Options:
  --project, -p <name>   Migrate one project only
  --help, -h             Show help text
`)
}

function printMigrateSummary(summary: MigrateSummary): void {
  let migrated = 0
  let blocked = 0

  for (const result of summary.results) {
    if (result.staleSlotsReleased > 0) {
      console.log(`Released ${result.staleSlotsReleased} stale slot(s) for ${result.projectId}`)
    }

    switch (result.status) {
      case "migrated":
        migrated++
        console.log(`Migrated ${result.projectId}: ${result.oldRepoPath} -> ${result.repoPath}`)
        break
      case "blocked":
        blocked++
        console.log(`Skipped ${result.projectId}: ${result.activeReferences} active worktree reference(s). Finish or cancel running tasks, then rerun.`)
        break
      case "current":
        console.log(`Current ${result.projectId}: ${result.repoPath}`)
        break
    }
  }

  if (migrated === 0 && blocked === 0) {
    console.log("No projects needed migration.")
  }
}
