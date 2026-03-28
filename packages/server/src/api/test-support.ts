import type { Database } from "bun:sqlite"
import type { ProjectConfig } from "@tangerine/shared"

export interface SeedTaskFixture {
  id: string
  projectId: string
  source?: string
  sourceId?: string | null
  sourceUrl?: string | null
  repoUrl?: string | null
  title: string
  description?: string | null
  status?: string
  provider?: string
  model?: string | null
  reasoningEffort?: string | null
  branch?: string | null
  worktreePath?: string | null
  type?: string
  prUrl?: string | null
  parentTaskId?: string | null
  userId?: string | null
  agentSessionId?: string | null
  agentPid?: number | null
  previewUrl?: string | null
  error?: string | null
  createdAt?: string
  updatedAt?: string
  startedAt?: string | null
  completedAt?: string | null
  lastSeenAt?: string | null
  lastResultAt?: string | null
}

export interface SeedActivityLogFixture {
  taskId: string
  type: string
  event: string
  content: string
  metadata?: Record<string, unknown> | null
  timestamp?: string
}

export interface SeedSessionLogFixture {
  taskId: string
  role: string
  content: string
  images?: string[] | null
  timestamp?: string
}

export interface SeedFixture {
  tasks: SeedTaskFixture[]
  activityLogs: SeedActivityLogFixture[]
  sessionLogs: SeedSessionLogFixture[]
}

export interface SeedResult {
  tasks: number
  activityLogs: number
  sessionLogs: number
}

const defaultSeedFixtureUrl = new URL("../test-fixtures/seed-data.json", import.meta.url)

function nowIso(): string {
  return new Date().toISOString()
}

function stringifyMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  return metadata ? JSON.stringify(metadata) : null
}

function stringifyImages(images: string[] | null | undefined): string | null {
  return images && images.length > 0 ? JSON.stringify(images) : null
}

function clearSeedTables(db: Database): void {
  db.prepare("DELETE FROM activity_log").run()
  db.prepare("DELETE FROM session_logs").run()
  db.prepare("DELETE FROM tasks").run()
}

export async function loadDefaultSeedFixture(): Promise<SeedFixture> {
  return await Bun.file(defaultSeedFixtureUrl).json() as SeedFixture
}

export function resetSeedData(db: Database): SeedResult {
  const beforeTasks = db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }
  const beforeActivityLogs = db.prepare("SELECT COUNT(*) AS count FROM activity_log").get() as { count: number }
  const beforeSessionLogs = db.prepare("SELECT COUNT(*) AS count FROM session_logs").get() as { count: number }

  db.transaction(() => {
    clearSeedTables(db)
  })()

  return {
    tasks: beforeTasks.count,
    activityLogs: beforeActivityLogs.count,
    sessionLogs: beforeSessionLogs.count,
  }
}

export function seedFixtureData(db: Database, fixture: SeedFixture, projects: ProjectConfig[]): SeedResult {
  const projectMap = new Map(projects.map((project) => [project.name, project]))
  const inserted = { tasks: 0, activityLogs: 0, sessionLogs: 0 }

  db.transaction(() => {
    clearSeedTables(db)

    const insertTask = db.prepare(`
      INSERT INTO tasks (
        id, project_id, source, source_id, source_url, repo_url, title, description,
        status, provider, model, reasoning_effort, branch, worktree_path, type, pr_url,
        parent_task_id, user_id, agent_session_id, agent_pid, preview_url, error,
        created_at, updated_at, started_at, completed_at, last_seen_at, last_result_at
      ) VALUES (
        $id, $project_id, $source, $source_id, $source_url, $repo_url, $title, $description,
        $status, $provider, $model, $reasoning_effort, $branch, $worktree_path, $type, $pr_url,
        $parent_task_id, $user_id, $agent_session_id, $agent_pid, $preview_url, $error,
        $created_at, $updated_at, $started_at, $completed_at, $last_seen_at, $last_result_at
      )
    `)
    const insertActivityLog = db.prepare(`
      INSERT INTO activity_log (task_id, type, event, content, metadata, timestamp)
      VALUES ($task_id, $type, $event, $content, $metadata, $timestamp)
    `)
    const insertSessionLog = db.prepare(`
      INSERT INTO session_logs (task_id, role, content, images, timestamp)
      VALUES ($task_id, $role, $content, $images, $timestamp)
    `)

    for (const task of fixture.tasks) {
      const project = projectMap.get(task.projectId)
      if (!project) {
        throw new Error(`Unknown project in seed fixture: ${task.projectId}`)
      }

      const timestamp = task.createdAt ?? nowIso()
      insertTask.run({
        $id: task.id,
        $project_id: task.projectId,
        $source: task.source ?? "manual",
        $source_id: task.sourceId ?? null,
        $source_url: task.sourceUrl ?? null,
        $repo_url: task.repoUrl ?? project.repo,
        $title: task.title,
        $description: task.description ?? null,
        $status: task.status ?? "created",
        $provider: task.provider ?? project.defaultProvider,
        $model: task.model ?? null,
        $reasoning_effort: task.reasoningEffort ?? null,
        $branch: task.branch ?? null,
        $worktree_path: task.worktreePath ?? null,
        $type: task.type ?? "code",
        $pr_url: task.prUrl ?? null,
        $parent_task_id: task.parentTaskId ?? null,
        $user_id: task.userId ?? null,
        $agent_session_id: task.agentSessionId ?? null,
        $agent_pid: task.agentPid ?? null,
        $preview_url: task.previewUrl ?? null,
        $error: task.error ?? null,
        $created_at: timestamp,
        $updated_at: task.updatedAt ?? timestamp,
        $started_at: task.startedAt ?? null,
        $completed_at: task.completedAt ?? null,
        $last_seen_at: task.lastSeenAt ?? null,
        $last_result_at: task.lastResultAt ?? null,
      })
      inserted.tasks++
    }

    for (const entry of fixture.activityLogs) {
      insertActivityLog.run({
        $task_id: entry.taskId,
        $type: entry.type,
        $event: entry.event,
        $content: entry.content,
        $metadata: stringifyMetadata(entry.metadata),
        $timestamp: entry.timestamp ?? nowIso(),
      })
      inserted.activityLogs++
    }

    for (const entry of fixture.sessionLogs) {
      insertSessionLog.run({
        $task_id: entry.taskId,
        $role: entry.role,
        $content: entry.content,
        $images: stringifyImages(entry.images),
        $timestamp: entry.timestamp ?? nowIso(),
      })
      inserted.sessionLogs++
    }
  })()

  return inserted
}
