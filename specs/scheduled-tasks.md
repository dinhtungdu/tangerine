# Scheduled Tasks

Scheduled tasks run automatically on a cron schedule. They are created once, then the server spawns a new worker run each time the schedule fires.

## Task Type

`"scheduled"` is a new `TaskType` alongside `worker`, `orchestrator`, and `reviewer`.

A scheduled task is a **template** — it holds the cron expression, prompt, provider config, and project reference. Each time the schedule fires, the scheduler creates a regular `worker` child task that does the actual work.

### Key differences from `worker`

| Aspect | Worker | Scheduled |
|--------|--------|-----------|
| Lifecycle | created → provisioning → running → done | Stays in `created` status as a template; spawns worker children |
| Agent process | Has one | Never has one (children do) |
| Branch/worktree | Gets its own | None (children get theirs) |
| Completion | Terminal | Never terminal while enabled |

## DB Schema Additions

Three new columns on the `tasks` table:

```sql
ALTER TABLE tasks ADD COLUMN cron_expression TEXT;
ALTER TABLE tasks ADD COLUMN schedule_enabled INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN next_run_at TEXT;
```

- `cron_expression` — standard 5-field cron (`* * * * *`). Only set for `type = 'scheduled'`.
- `schedule_enabled` — `0` or `1`. Controls whether the scheduler fires this task.
- `next_run_at` — ISO 8601 timestamp of the next scheduled run. Computed from `cron_expression` after each firing or when the schedule is created/updated.

## Schedule Config in Shared Types

```typescript
export type TaskType = "worker" | "orchestrator" | "reviewer" | "scheduled"

// New fields on the Task interface
interface Task {
  // ... existing fields ...
  cronExpression: string | null
  scheduleEnabled: boolean
  nextRunAt: string | null
}

// New capability
export type TaskCapability = "resolve" | "predefined-prompts" | "diff" | "continue" | "pr-track" | "pr-create" | "schedule"
```

Scheduled tasks get the `"schedule"` capability only — they don't resolve, diff, or continue since they never run an agent themselves.

## Scheduler Service

A server-side service (`packages/server/src/tasks/scheduler.ts`) that polls for due scheduled tasks.

### Polling loop

- Runs on a fixed interval (60 seconds).
- Queries: `SELECT * FROM tasks WHERE type = 'scheduled' AND schedule_enabled = 1 AND next_run_at <= datetime('now')`.
- For each due task:
  1. Create a new `worker` child task with `parentTaskId` set to the scheduled task's ID, inheriting the prompt, provider, model, and project.
  2. Compute the next run time from `cron_expression` and update `next_run_at`.
  3. Log activity on the scheduled task.

### Cron parsing

Use the `cron-parser` npm package (lightweight, no native deps, works with Bun). Parse 5-field expressions only — no seconds field.

### Integration

- Started during server startup in `cli/start.ts`, alongside the health monitor and PR monitor.
- Stopped on server shutdown.

## API Changes

### POST /api/tasks

Accept `type: "scheduled"` with additional fields:

```json
{
  "type": "scheduled",
  "cronExpression": "0 9 * * 1-5",
  "scheduleEnabled": true,
  ...standard fields (title, projectId, description, provider, model)
}
```

Validation:
- `cronExpression` is required when `type = "scheduled"`.
- `cronExpression` must be a valid 5-field cron expression.
- `scheduleEnabled` defaults to `true`.
- Scheduled tasks are NOT auto-started (no agent process).

### PATCH /api/tasks/:id

Allow updating schedule fields for scheduled tasks:

```json
{
  "scheduleEnabled": false,
  "cronExpression": "0 */6 * * *"
}
```

When `cronExpression` changes, recompute `next_run_at`.

### GET /api/tasks/:id and GET /api/tasks

Return schedule fields in the response:

```json
{
  "cronExpression": "0 9 * * 1-5",
  "scheduleEnabled": true,
  "nextRunAt": "2026-03-31T09:00:00.000Z"
}
```

## Task Manager Changes

- `createTask()`: For `type = "scheduled"`, set capabilities to `["schedule"]`, compute initial `next_run_at`, and do NOT fork a session.
- Scheduled tasks skip provisioning entirely — they are templates, not runnable tasks.

## Web UI

### Runs table

- Show scheduled tasks with a clock/calendar icon and their cron schedule in human-readable form (e.g., "Weekdays at 9:00 AM").
- Show the next run time.
- Show enable/disable toggle inline.

### New task form

- Add "Scheduled" option to the task type selector.
- When selected, show a cron expression input field with human-readable preview.
- Show an "Enabled" toggle (default: on).

### Task detail page

- Show schedule info (cron expression, human-readable, next run, enabled status).
- Show child task history (runs spawned by this schedule).
- Allow editing cron expression and toggling enabled state.

## Lifecycle

```
User creates scheduled task
  → Task saved with status "created", schedule_enabled=1, next_run_at computed
  → Scheduler poll loop fires
  → next_run_at <= now? Create worker child, update next_run_at
  → Worker child goes through normal lifecycle: provisioning → running → done
  → Repeat on next schedule

User disables schedule
  → PATCH scheduleEnabled=false
  → Scheduler skips this task

User re-enables
  → PATCH scheduleEnabled=true
  → next_run_at recomputed from now
```

## Out of Scope

- Sub-minute scheduling (cron minimum is 1 minute)
- Missed run catch-up (if server was down during a scheduled time, it fires once on next poll, not multiple times)
- Concurrent run limits (if a previous child is still running when the next schedule fires, a new child is created anyway)
- Calendar/date-based one-time schedules (only recurring cron)
