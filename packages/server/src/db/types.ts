export interface TaskRow {
  id: string
  project_id: string
  source: string
  source_id: string | null
  source_url: string | null
  repo_url: string
  title: string
  description: string | null
  status: string
  provider: string
  model: string | null
  reasoning_effort: string | null
  branch: string | null
  worktree_path: string | null
  pr_url: string | null
  user_id: string | null
  agent_session_id: string | null
  agent_pid: number | null
  preview_url: string | null
  error: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  last_seen_at: string | null
}

export interface SessionLogRow {
  id: number
  task_id: string
  role: string
  content: string
  images: string | null
  timestamp: string
}

export type WorktreeSlotStatus = "available" | "bound" | "initializing"

export interface WorktreeSlotRow {
  id: string
  project_id: string
  path: string
  status: WorktreeSlotStatus
  task_id: string | null
  created_at: string
}
