# Orchestrator

The orchestrator is a special per-project task that acts as a coordinator for all other tasks in the project. It runs on the default branch (not in an isolated worktree) and is automatically managed via idle timeout and context rotation.

## What makes it special

| Property | Regular task | Orchestrator |
|---|---|---|
| Branch | `tangerine/<task-prefix>` (isolated) | Default branch (`main`) |
| Worktree | Dedicated slot from pool | Slot 0 (reserved) |
| Start | Auto-provisions on creation | On-demand (when user opens chat) |
| Lifecycle | Created → done/failed | Created → running → done (auto) → auto-resumed |
| Count | Many per project | One active per project (enforced) |
| History | Independent | Chained via `parentTaskId` |
| Retry | Creates new task with same params | Not applicable — auto-resume handles it |

## Lifecycle

### Creation

`POST /api/projects/:name/orchestrator` (lazy create):

1. Active orchestrator exists → return it (no-op)
2. Terminal orchestrator exists → create new one, set `parentTaskId` to the most recent terminal one
3. No orchestrator exists → create one fresh

The `parentTaskId` chain lets the new orchestrator access its predecessor's conversation history for continuity.

### Start

Orchestrators do **not** auto-start on creation. They start when the user opens the chat for the first time via `POST /api/tasks/:id/start`. This avoids spinning up an agent process for a project the user hasn't visited yet.

### Idle timeout

The health monitor tracks the last user message time for all running tasks (not just orchestrators). If no user message arrives within `DEFAULT_IDLE_TIMEOUT_MS` (10 minutes), the task is completed (`done`). This frees resources when the user is away. The agent process is killed and cleaned up via normal `completeTask` flow.

### Auto-resume

When a user sends a message (via `POST /api/tasks/:id/prompt` or `POST /api/tasks/:id/chat`) to a done/failed/cancelled orchestrator, the system automatically:

1. Creates a new orchestrator via `ensureOrchestrator` (linked via `parentTaskId`)
2. Starts the new orchestrator's agent session
3. Delivers the user's message to the new orchestrator
4. Returns the new task ID in the response (`redirected: true`)

This is transparent to the user — they message the old orchestrator and the system handles the handoff.

### Termination and restart

Orchestrators reach `done` status through two paths:
1. **Idle timeout** — no user messages for 10 minutes
2. **Manual** — user or system explicitly completes it

In all cases, the next user interaction auto-resumes via `ensureOrchestrator`.

`POST /api/projects/:name/orchestrator` also handles explicit restart: if the current orchestrator is terminal, it creates a new one with the previous one as parent.

## Constraints

- **One active per project**: `createTask` rejects a second orchestrator if one is already in a non-terminal state.
- **Default branch only**: orchestrators always use the project's `defaultBranch`. They never create a `tangerine/*` branch.
- **No worktree isolation**: the orchestrator works directly in the main repo clone (slot 0), so it can see the full project state and delegate to sub-tasks.

## UI rules

- **Task list**: orchestrator is filtered out of the regular task list — it has its own entry point in the sidebar.
- **Terminated banner**: shows "Restart orchestrator" instead of "Continue in new task". Does **not** show "Mark as done" (that button is for regular tasks only).
- **No retry button**: the retry flow (create new task with same params) doesn't apply to orchestrators.
- **Auto-resume is transparent**: if the user sends a message to a done orchestrator, the prompt/chat endpoint handles the redirect automatically. The UI should follow the `redirected` flag and `taskId` in the response to switch to the new orchestrator.

## Role and prompt

The orchestrator is initialized with a system prompt that instructs it to:

- Coordinate work by creating sub-tasks in isolated worktrees
- Monitor running tasks, review diffs, send prompts to agents
- Delegate: break down large work items into parallel sub-tasks
- Do small direct changes (docs, config, quick fixes) on the main branch when delegation would be wasteful — and always tell the user when doing so

Model selection guidance is included: opus for complex/ambiguous work, sonnet for straightforward tasks.
