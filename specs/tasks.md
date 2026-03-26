# Tasks

Tasks are units of work. Sourced from external issue trackers, not created manually.

## Sources

### GitHub Issues (v0)

Two mechanisms — polling (primary) and webhooks (optional):

**Polling** (primary): GitHub REST API polls open issues on a configurable interval (default 60 min). Filters by label or assignee trigger. Deduplicates by `github:<repo>#<number>` source ID.

**Webhooks** (optional): `POST /webhooks/github` receives `issues` events. HMAC-SHA256 signature verification. Fires on `opened`, `labeled`, `assigned` actions.

Both use the same trigger config and task creation path:
- **Trigger**: issue labeled with configurable label (e.g. `agent`) or assigned to a specific user
- **Payload**: title, body, repo, issue number, author
- **Mapping**: one issue = one task

### Linear (future)

Webhook or poll:
- Issue assigned or moved to specific status
- Linear issue ID linked to task

### Manual (fallback)

Via API or web dashboard:
```
POST /api/tasks { title, description, projectId, provider }
```

## Task Lifecycle

```
created → provisioning → running → done
                                 → failed
         → cancelled (from any non-terminal state)

Retry (from terminal):
  failed ──→ cancelled (old) + created (new task, same params)
  cancelled ──→ cancelled (old) + created (new task, same params)
```

| Status | Description |
|--------|-------------|
| `created` | Task received, queued |
| `provisioning` | Getting VM, creating worktree, starting agent |
| `running` | Agent session active, accepting prompts |
| `done` | PR created, session ended |
| `failed` | Error during provisioning or execution |
| `cancelled` | User cancelled |

### Transitions

| From | To | Trigger |
|------|----|---------|
| created | provisioning | VM available (or being provisioned) |
| provisioning | running | Agent started, session ready |
| provisioning | failed | VM, worktree, or agent setup error |
| running | done | User marks done / PR merged |
| running | failed | VM died, health check failure, unrecoverable error |
| any active | cancelled | User cancels |
| failed/cancelled | new task (created) | User retries via `POST /api/tasks/:id/retry` |

### Retry

`POST /api/tasks/:id/retry` on a `failed` or `cancelled` task:

1. Clean up old task's worktree (via `cleanupSession`)
2. Mark old task as `cancelled`
3. Create a new task with the same params (title, description, project, provider, model, source)
4. New task enters normal `created → provisioning → running` flow

The old task remains in the DB for audit. The new task gets a fresh ID, branch, and worktree.

## Task Data

### DB Schema

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,           -- github|linear|manual|api
  source_id TEXT,                 -- github issue number, linear issue ID
  source_url TEXT,                -- link back to issue
  repo_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  provider TEXT NOT NULL DEFAULT 'opencode',  -- opencode|claude-code
  vm_id TEXT,
  branch TEXT,
  worktree_path TEXT,             -- /workspace/worktrees/<task-prefix>
  pr_url TEXT,
  user_id TEXT,                   -- nullable for v0 (multiplayer-ready)
  agent_session_id TEXT,          -- agent session ID (OpenCode session or Claude Code UUID)
  agent_port INTEGER,             -- local tunneled port for agent API (OpenCode only)
  preview_port INTEGER,           -- local tunneled port for preview
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
```

## Worktree Isolation

Each task gets its own git worktree branching from the default branch. The main repo clone lives at `/workspace/repo`, worktrees at `/workspace/worktrees/<task-id-prefix>`.

Multiple tasks can run concurrently on the same VM — each in its own worktree with its own agent process.

## Task → Branch → PR

1. Task created → branch name: `tangerine/<task-prefix>` (8-char prefix of task ID)
2. Agent works on branch in worktree
3. Agent or system creates PR via `gh pr create`
4. PR URL stored in task record
5. PR linked back to original issue

### PR Attribution

v0: PRs created as the configured GitHub token owner.
Future (hosted): PRs created as the user who triggered the task (GitHub OAuth).

## Cleanup

`cleanupSession()` runs on completion, cancellation, health-check failure, retry, and delete:

1. Persist chat messages (best-effort — skipped if no agent port/session)
2. Shutdown agent handle (kills process, closes tunnel/SSE)
3. Remove worktree from VM (`git worktree remove --force`, falls back to `rm -rf`)
   - Skipped if VM is destroyed or unavailable
4. Clear `worktree_path` in DB (prevents orphan detection from re-triggering)
5. VM persists for the project — not destroyed

### worktree_path Lifecycle

- **Set** during provisioning (`startSession` → step 5)
- **Cleared** by `cleanupSession` after worktree removal (or if VM unavailable)
- Terminal tasks with `worktree_path` still set are considered **orphans** (see below)

### Orphan Cleanup

Safety net for crashes, SSH failures, or bugs that prevent normal cleanup. Modeled after Orange's `cleanupOrphans()`.

- **Detection**: terminal tasks (`done`, `failed`, `cancelled`) with `worktree_path` still set
- **Interval**: every 30 seconds (background fiber via `startOrphanCleanup`)
- **Action**: calls `cleanupSession` for each orphan → removes worktree + clears path
- **Errors**: caught and logged per-task, never crashes the loop

### Health Check → Cleanup

When health checks detect failure (VM unreachable, OpenCode unresponsive + restart failed):

1. Mark task as `failed` with reason
2. Call `cleanupSession` → removes worktree, clears path
3. Orphan cleanup catches any that slip through

## GitHub Integration

### Polling (primary)

Runs on a configurable interval (`integrations.github.pollIntervalMinutes`, default 60). Uses `GITHUB_TOKEN` to fetch open issues via GitHub REST API. Filters by trigger config (label or assignee), deduplicates by `github:<repo>#<number>`, creates tasks for new matches.

### Webhook (optional)

1. Create GitHub webhook on repo (or org-wide)
2. Point to `http://<host>:<port>/webhooks/github`
3. Set secret for signature verification (`integrations.github.webhookSecret`)
4. Subscribe to `issues` events

```
POST /webhooks/github
  → Verify HMAC-SHA256 signature
  → Check event type (issues.opened, issues.labeled, issues.assigned)
  → Check label/assignee matches trigger config
  → Create task
  → Respond 202 Accepted
  → Async: get VM, create worktree, start session
```

### Git Authentication

See [credentials.md](./credentials.md) for full details. Git uses the machine's configured credentials (SSH keys, `GITHUB_TOKEN` env var).

## Session Retry (provisioning)

`startSessionWithRetry` wraps `startSession` with exponential backoff (1s, 2s, 4s — max 3 attempts). On exhaustion: task marked `failed`, worktree cleaned up.

`reconnectSessionWithRetry` does the same for `reconnectSession` (lightweight reconnect — skips worktree/setup, just restarts agent with `--resume`).

## Server Restart Recovery

`resumeOrphanedTasks()` runs on startup (and after VM rebuild):

| Task status | Recovery action |
|-------------|-----------------|
| `created` / `provisioning` | Reset to `created`, full `startSessionWithRetry` |
| `running` | Lightweight `reconnectSessionWithRetry` (reuse worktree, `--resume`) |

Tasks with unknown projects are marked `failed`.

## Concurrency

Multiple tasks can run in parallel on the same project VM (each in its own worktree). Not limited by pool size — limited by VM resources.
