export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT,
    source_url TEXT,
    repo_url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    provider TEXT NOT NULL DEFAULT 'opencode',
    model TEXT,
    vm_id TEXT,
    branch TEXT,
    worktree_path TEXT,
    pr_url TEXT,
    user_id TEXT,
    agent_session_id TEXT,
    agent_port INTEGER,
    preview_port INTEGER,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_vm_id ON tasks(vm_id);

  CREATE TABLE IF NOT EXISTS vms (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    provider TEXT NOT NULL,
    ip TEXT,
    ssh_port INTEGER,
    status TEXT NOT NULL DEFAULT 'provisioning',
    project_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    region TEXT NOT NULL,
    plan TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_vms_status ON vms(status);
  CREATE INDEX IF NOT EXISTS idx_vms_project_id ON vms(project_id);

  CREATE TABLE IF NOT EXISTS session_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  CREATE INDEX IF NOT EXISTS idx_session_logs_task_id ON session_logs(task_id);

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

  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    logger TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_system_logs_logger ON system_logs(logger);
  CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON system_logs(timestamp);
`
