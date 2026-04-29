import { DEFAULT_AGENT_ID } from "@tangerine/shared"

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT,
    source_url TEXT,
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'worker',
    description TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    provider TEXT NOT NULL DEFAULT '${DEFAULT_AGENT_ID}',
    model TEXT,
    reasoning_effort TEXT,
    branch TEXT,
    worktree_path TEXT,
    pr_url TEXT,
    pr_status TEXT,
    parent_task_id TEXT,
    user_id TEXT,
    agent_session_id TEXT,
    agent_pid INTEGER,
    suspended INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    last_seen_at TEXT,
    last_result_at TEXT,
    capabilities TEXT,
    context_tokens INTEGER NOT NULL DEFAULT 0,
    context_window_max INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);

  CREATE TABLE IF NOT EXISTS crons (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    cron TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT,
    task_defaults TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_crons_enabled ON crons(enabled);

  CREATE TABLE IF NOT EXISTS stream_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    event_json TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  CREATE INDEX IF NOT EXISTS idx_stream_events_task_id ON stream_events(task_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_events_task_seq ON stream_events(task_id, seq);

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    type TEXT NOT NULL,
    event TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  CREATE INDEX IF NOT EXISTS idx_activity_log_task_id ON activity_log(task_id);

  CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    logger TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT,
    task_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_system_logs_logger ON system_logs(logger);
  CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON system_logs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_system_logs_task_id ON system_logs(task_id);

  CREATE TABLE IF NOT EXISTS worktree_slots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    task_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  CREATE INDEX IF NOT EXISTS idx_worktree_slots_project_status ON worktree_slots(project_id, status);
`
