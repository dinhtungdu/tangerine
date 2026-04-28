# Orchestrator

The orchestrator is a special per-project task that acts as a coordinator for all other tasks in the project. It runs on the default branch (not in an isolated worktree) and is automatically managed via idle suspension.

## What makes it special

| Property | Regular task | Orchestrator |
|---|---|---|
| Branch | `tangerine/<task-prefix>` (isolated) | Default branch (`main`) |
| Worktree | Dedicated slot from pool | Slot 0 (reserved) |
| Start | Auto-provisions on creation | On-demand (when user opens chat) |
| Lifecycle | Created → done/failed | Created → running → failed/cancelled → restarted |
| Count | Many per project | One active per project (enforced) |
| History | Independent | Chained via `parentTaskId` |
| Retry | Creates new task with same params | Not applicable — use restart |

## Lifecycle

### Creation

`POST /api/projects/:name/orchestrator` (lazy create):

1. Active orchestrator exists → return it (no-op)
2. Terminal orchestrator exists → create new one, set `parentTaskId` to the most recent terminal one
3. No orchestrator exists → create one fresh

The `parentTaskId` chain lets the new orchestrator access its predecessor's conversation history for continuity.

### Start

Orchestrators do **not** auto-start on creation. They start when the user opens the chat for the first time via `POST /api/tasks/:id/start`. This avoids spinning up an agent process for a project the user hasn't visited yet.

### Idle suspension

The health monitor tracks the last user message time for all running tasks (not just orchestrators). If no user message arrives within `DEFAULT_IDLE_TIMEOUT_MS` (10 minutes), the agent process is killed to free resources — but the task stays `running`. When the next user message arrives, the agent is automatically restarted via `reconnectSessionWithRetry` and the message is delivered.

This applies to ACP agents that support `session/resume` or `session/load`. If neither is supported, Tangerine creates a fresh ACP session and re-sends pending prompt context when needed.

### Termination and restart

When an orchestrator ends (`failed` or `cancelled`), the correct action is to **restart** it — which creates a new orchestrator task linked to the old one via `parentTaskId`. There is no "mark as done" for orchestrators; they are meant to run indefinitely.

`POST /api/projects/:name/orchestrator` handles the restart: if the current orchestrator is terminal, it creates a new one with the previous one as parent.

## Constraints

- **One active per project**: `createTask` rejects a second orchestrator if one is already in a non-terminal state.
- **Default branch only**: orchestrators always use the project's `defaultBranch`. They never create a `tangerine/*` branch.
- **No worktree isolation**: the orchestrator works directly in the main repo clone (slot 0), so it can see the full project state and delegate to sub-tasks.
- **Agent-agnostic**: orchestrators are regular ACP-backed tasks. Agent selection resolves from explicit request, then `taskTypes.orchestrator.agent`, then project/global defaults. No Claude-specific fallback or model name is hardcoded.

## UI rules

- **Task list**: orchestrator is filtered out of the regular task list — it has its own entry point in the sidebar.
- **Terminated banner**: shows "Restart orchestrator" instead of "Continue in new task". Does **not** show "Mark as done" (that button is for regular tasks only).
- **No retry button**: the retry flow (create new task with same params) doesn't apply to orchestrators.

## Role and prompt

The orchestrator is initialized with a system prompt that instructs it to:

- Coordinate work by creating sub-tasks in isolated worktrees
- Monitor running tasks, review diffs, send prompts to agents
- Delegate: break down large work items into parallel sub-tasks
- Do small direct changes (docs, config, quick fixes) on the main branch when delegation would be wasteful — and always tell the user when doing so

Model selection guidance stays provider-neutral: use the most capable configured model for ambiguous work, and a faster/cheaper configured model for straightforward work. Projects may set `taskTypes.orchestrator.agent`, `taskTypes.orchestrator.model`, and `taskTypes.orchestrator.reasoningEffort`; explicit API values still override those defaults.
