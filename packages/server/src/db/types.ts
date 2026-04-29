export interface TaskRow {
  id: string
  project_id: string
  source: string
  source_id: string | null
  source_url: string | null
  title: string
  type: string
  description: string | null
  status: string
  provider: string
  model: string | null
  reasoning_effort: string | null
  branch: string | null
  worktree_path: string | null
  pr_url: string | null
  pr_status: string | null
  parent_task_id: string | null
  user_id: string | null
  agent_session_id: string | null
  agent_pid: number | null
  suspended: number
  error: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  last_seen_at: string | null
  last_result_at: string | null
  capabilities: string | null
  context_tokens: number
  context_window_max?: number | null
}

export interface CronRow {
  id: string
  project_id: string
  title: string
  description: string | null
  cron: string
  enabled: number
  next_run_at: string | null
  task_defaults: string | null
  created_at: string
  updated_at: string
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
