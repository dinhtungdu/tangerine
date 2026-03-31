# Crons

A cron is a separate entity from tasks. It holds a cron expression and task defaults. On each fire, the scheduler creates a regular worker task.

## DB Schema

```sql
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
```

- `cron` — 5-field cron expression (e.g. `0 9 * * 1-5`)
- `enabled` — 0 or 1
- `next_run_at` — ISO 8601 timestamp, computed from `cron` after each fire
- `task_defaults` — JSON with provider, model, reasoningEffort, branch. Merged into the worker task on creation.

## Shared Types

```typescript
export interface Cron {
  id: string
  projectId: string
  title: string
  description: string | null
  cron: string
  enabled: boolean
  nextRunAt: string | null
  taskDefaults: { provider?: string; model?: string; reasoningEffort?: string; branch?: string } | null
  createdAt: string
  updatedAt: string
}
```

## API

### `GET /api/crons`
List crons. Optional `?project=<id>` filter.

### `POST /api/crons`
```json
{
  "projectId": "my-project",
  "title": "Nightly checks",
  "description": "Run test suite",
  "cron": "0 9 * * 1-5",
  "enabled": true,
  "taskDefaults": { "provider": "claude-code", "model": "claude-sonnet-4-6" }
}
```

### `GET /api/crons/:id`
Get a single cron.

### `PATCH /api/crons/:id`
Update cron, enabled, title, description, taskDefaults. When `cron` changes, recompute `next_run_at`.

### `DELETE /api/crons/:id`
Delete a cron.

## Scheduler

Polls every 60s. Query: `SELECT * FROM crons WHERE enabled = 1 AND next_run_at <= now`.

For each due cron:
1. Check if a task with `source_id = 'cron:<cron_id>'` is already active → skip if so
2. Create a worker task: `source: "cron"`, `source_id: "cron:<cron_id>"`, inherits title/description/provider/model/branch from the cron + task_defaults
3. Advance `next_run_at`
4. Log activity

## Task Source

Tasks spawned by crons have `source: "cron"` and `source_id: "cron:<cron_id>"`. No `schedule` column on tasks, no `scheduled` task type.

## Web UI

- Cron CRUD in settings or a dedicated "Crons" section
- Runs table shows cron-spawned tasks like any other task, with a cron badge derived from `source === "cron"`
- New cron form: title, description, cron expression, project, provider/model defaults

## Out of Scope

- Sub-minute scheduling
- Missed-run catch-up
- Calendar/date-based one-time schedules
