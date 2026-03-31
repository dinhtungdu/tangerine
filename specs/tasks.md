# Tasks

Tasks are Tangerine's unit of work. They are backed by a DB record, a git branch, an optional worktree, a local agent process, and associated session/activity logs.

## Sources

Current `source` values:

- `manual`
- `github`
- `cross-project`

The task manager type also still accepts `"api"` internally in retry paths, but the public create route currently normalizes new tasks to `manual` or `cross-project`.

### GitHub

GitHub tasks can be created by:

- webhook via `POST /webhooks/github`
- polling via `integrations/poller.ts`

Tasks are deduplicated through source metadata and mapped from issue payloads.

### Manual

Tasks can be created from:

- the web UI
- `POST /api/tasks`
- `tangerine task create`

### Cross-Project

Other Tangerine tasks can prompt an orchestrator or worker by calling `POST /api/tasks/:id/prompt` or by creating a new task with `source: "cross-project"`.

## Task Types

Current `type` values:

- `worker`
- `orchestrator`
- `reviewer`

Capabilities are derived from type in `tasks/manager.ts`:

| Type | Capabilities |
|------|--------------|
| `worker` | `resolve`, `predefined-prompts`, `diff`, `continue` |
| `orchestrator` | `resolve`, `predefined-prompts` |
| `reviewer` | `resolve`, `predefined-prompts`, `diff` |

Orchestrators are created lazily and started on demand. Other task types auto-start after creation.

## Lifecycle

```text
created -> provisioning -> running -> waiting-review -> done
                                 -> done
                                 -> failed
                                 -> cancelled
```

`waiting-review` is an intermediate state between `running` and `done`. A task enters this state when the worker has created a PR and stopped its agent — the work is complete but the PR hasn't been merged yet.

Additional flows:

- `waiting-review` -> start resumes the agent on the same branch (for PR updates)
- `failed`, `cancelled`, or `waiting-review` -> retry creates a fresh task
- `failed`, `cancelled`, or `waiting-review` -> resolve marks as done
- `running` -> restart recovery reconnects or resumes
- terminal tasks (including `waiting-review`) can be deleted after cleanup

## Start Flow

At a high level:

1. Read project config
2. Fetch repo state
3. Acquire or create a worktree slot
4. Create branch/worktree
5. Start local agent process for the chosen provider
6. Persist session/process metadata
7. Stream events to logs and WebSockets

The implementation lives across:

- `tasks/lifecycle.ts`
- `tasks/retry.ts`
- `tasks/manager.ts`
- `tasks/worktree-pool.ts`

## Runtime Features

- prompt queue while the agent is busy
- idle suspension and later wake-up
- model/reasoning-effort changes
- PR detection and PR URL persistence
- last-seen and last-result timestamps
- parent/child task linkage

## Database Shape

Current `tasks` table fields:

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT,
  source_url TEXT,
  repo_url TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'worker',
  description TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  provider TEXT NOT NULL DEFAULT 'opencode',
  model TEXT,
  reasoning_effort TEXT,
  branch TEXT,
  worktree_path TEXT,
  pr_url TEXT,
  parent_task_id TEXT,
  user_id TEXT,
  agent_session_id TEXT,
  agent_pid INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  last_seen_at TEXT,
  last_result_at TEXT,
  capabilities TEXT
)
```

Related tables:

- `session_logs`
- `activity_log`
- `system_logs`
- `worktree_slots`
- `crons` — see `specs/crons.md`

## Cron-Spawned Tasks

Tasks with `source: "cron"` are regular workers spawned by the scheduler from cron records. They have `source_id: "cron:<cron_id>"` for linkage. The scheduler polls every 60 seconds and skips crons that already have an active task. See `specs/crons.md` for the full design.

## Worktree Isolation

Each running task operates inside its own worktree slot under the configured workspace. Worktree slots are tracked separately so Tangerine can reconcile stale state after crashes or restarts.

## Cleanup

Cleanup runs when tasks are:

- completed
- cancelled
- retried
- deleted
- detected as orphans

Cleanup responsibilities include:

- shutting down the agent handle if present
- removing worktrees
- clearing persisted worktree/process state

## Recovery

On startup, Tangerine resumes orphaned work:

- `created` and `provisioning` tasks are restarted from the beginning
- `running` tasks are reconnected through provider-specific resume logic

Health monitoring and reconnect locking prevent duplicate recovery loops.
