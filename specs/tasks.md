# Tasks

Tasks are units of work. Sourced from external issue trackers, not created manually.

## Sources

### GitHub Issues (v0)

Webhook on issue events:
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
| running | failed | VM died, unrecoverable error |
| any active | cancelled | User cancels |

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

On task completion/cancellation:
1. Persist chat messages (best-effort)
2. Shutdown agent handle (kills process, closes tunnel/SSE)
3. Remove worktree from VM (`git worktree remove --force`)
4. VM persists for the project — not destroyed

## GitHub Webhook Handler

### Setup

1. Create GitHub webhook on repo (or org-wide)
2. Point to `http://<host>:<port>/webhooks/github`
3. Set secret for signature verification
4. Subscribe to `issues` events

### Processing

```
POST /webhooks/github
  → Verify signature
  → Check event type (issues.labeled, issues.assigned)
  → Check label/assignee matches config
  → Create task
  → Respond 202 Accepted
  → Async: get VM, create worktree, start session
```

## Concurrency

Multiple tasks can run in parallel on the same project VM (each in its own worktree). Not limited by pool size — limited by VM resources.
