# Conversation Branching

**Status**: Draft
**Author**: Tung Du
**Date**: 2026-04-13

## Problem

When an agent takes a wrong turn mid-conversation, the only options are to cancel and start over (losing all context) or try to course-correct (fighting accumulated context). There's no way to "go back" to a known-good point and try a different approach.

Pi supports conversation trees natively. Tangerine should offer this at the wrapper level so it works across all providers (Claude Code, OpenCode, Codex, Pi).

## Design

### Core Concept: Checkpoints

A **checkpoint** is a snapshot of both conversation state and file state at a specific point in a task's history. Tangerine already stores conversation history in `session_logs` and uses git worktrees for file isolation — checkpoints connect the two.

Each time an agent completes a turn (emits `status: idle`), Tangerine:
1. Auto-commits the worktree state (if dirty) to a checkpoint ref
2. Records the checkpoint in the database, linked to the last `session_logs` entry

This is lightweight — git commits are cheap, and we only checkpoint on idle (not mid-tool-use).

### Branching

A **branch** creates a new task that starts from a checkpoint of an existing task:

1. User picks a message in the conversation timeline and clicks "Branch from here"
2. Tangerine creates a new task with `parent_task_id` pointing to the source task
3. The new task's worktree is initialized from the checkpoint's git commit (not from `origin/main`)
4. The conversation history up to that message is replayed into the new agent session as context

The new task is fully independent — its own worktree, its own branch, its own agent process.

### What Gets Restored

| Aspect | Restored? | How |
|--------|-----------|-----|
| Files | Yes | `git checkout` from checkpoint commit |
| Conversation context | Yes | Replay `session_logs` up to branch point as system context |
| Agent internal state | No | Fresh agent session — provider-specific state (tool caches, thinking) is lost |
| External side effects | No | PRs created, APIs called, etc. are not reversible |

The conversation replay is "best effort context" — the agent gets the history as a prompt prefix, not as its native session state. This is a deliberate tradeoff: it works across all providers uniformly, at the cost of losing provider-specific optimizations (e.g., Claude Code's `--resume` with exact internal state).

## Database Changes

### New table: `checkpoints`

```sql
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,              -- UUID
  task_id TEXT NOT NULL,            -- source task
  session_log_id INTEGER NOT NULL,  -- the session_log entry this checkpoint follows
  commit_sha TEXT NOT NULL,         -- git commit hash
  turn_index INTEGER NOT NULL,     -- sequential turn number (0-based)
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (session_log_id) REFERENCES session_logs(id)
);
```

### Tasks table additions

```sql
ALTER TABLE tasks ADD COLUMN branched_from_checkpoint_id TEXT
  REFERENCES checkpoints(id);
```

This links a branched task back to its origin checkpoint. Combined with `parent_task_id` (which points to the source task), we have full lineage.

## Checkpoint Lifecycle

### Creation

Triggered in the agent event pipeline when `status: idle` fires:

```
Agent emits "status: idle"
  → Is worktree dirty? (git status)
    → Yes: git add -A && git commit -m "checkpoint: turn {N}"
    → No: use current HEAD
  → Insert checkpoint row (task_id, session_log_id of last assistant message, commit_sha, turn_index)
```

Checkpoint commits live on a detached ref namespace: `refs/checkpoints/{task_id}/{turn_index}`. They don't pollute the task's working branch.

### Storage

Checkpoint commits are lightweight git objects. For a task with 20 turns, that's at most 20 commits — negligible storage. Refs are local-only (never pushed).

### Cleanup

When a task reaches a terminal state (done/failed/cancelled):
- **Keep checkpoints for 24 hours** (configurable) to allow late branching
- After TTL: delete checkpoint refs (`git update-ref -d`), delete DB rows
- Checkpoint commits become unreachable and are cleaned up by `git gc`

## Branch Creation Flow

### API

```
POST /api/tasks/:taskId/branch
{
  "checkpoint_id": "uuid",        -- which checkpoint to branch from
  "title": "Try different approach",
  "description": "...",           -- optional
  "provider": "claude-code",      -- optional, defaults to source task's provider
  "model": "...",                 -- optional, defaults to source task's model
}
```

Response: the newly created task (same shape as `POST /api/tasks`).

### Server-side flow

1. **Validate** — checkpoint exists, source task belongs to caller's project
2. **Create task** — `type: "worker"`, `parent_task_id: sourceTask.id`, `branched_from_checkpoint_id: checkpoint.id`, `source: "branch"`
3. **Acquire worktree slot** — from pool (same as normal task creation)
4. **Restore file state** — In the new worktree:
   ```bash
   git checkout -b tangerine/{new_task_id_prefix} {checkpoint_commit_sha}
   ```
5. **Build conversation prefix** — Query `session_logs` for source task, up to and including the checkpoint's `session_log_id`. Format as a conversation transcript.
6. **Start agent** — Normal `agentFactory.start()`, but prepend the conversation prefix to the first prompt's system notes
7. **Send initial prompt** — If the user provided a new instruction with the branch request, send it. Otherwise the agent starts idle, waiting for input.

### Conversation Prefix Format

The replayed history is injected as a system note block, not as fake user/assistant turns (which would confuse providers):

```
[CONTEXT: This task was branched from task {source_task_id} at turn {N}. 
The conversation up to that point is provided below for context.
You are starting fresh from that point — the files match the state at turn {N}.]

<prior-conversation>
User: {message 1}
Assistant: {message 2}
User: {message 3}
Assistant: {message 4}
...up to checkpoint...
</prior-conversation>
```

This keeps the provider's native conversation model clean (it sees one system block + fresh user messages) while giving the agent full context.

### Context Window Considerations

Long conversations may exceed the context window when replayed. Mitigation:
- **Truncation**: If the prefix exceeds a configurable token budget (default: 50% of provider's context window), truncate from the beginning, keeping the most recent N turns
- **Summary mode**: For very long conversations, summarize early turns and include verbatim only the last M turns
- Start simple (truncation only), add summarization later if needed

## Web UI

### Conversation Timeline

Each message in the chat view gets a subtle "Branch" affordance (icon or menu item) on hover. Clicking it opens a modal/drawer:

- Shows the checkpoint metadata (turn number, timestamp, file diff summary)
- Lets user set title, optionally change provider/model
- "Create Branch" button → calls the API

### Task Lineage Header

The task detail view shows branching lineage inline:
- "Branched from: {parent task title} at turn {N}" with a link back
- Badge showing branch depth (e.g., "Branch 2 of 3")

### Conversation Tree Pane

A dedicated pane in the task detail view — alongside Chat, Diff, Terminal, and Activity — showing the **full family tree** for any task. Inspired by Pi's tree navigation.

**Visibility**: The "Tree" tab appears in the pane tab bar once the task has at least one checkpoint OR is part of a family (has `parent_task_id` or has children branched from it). For fresh tasks with no history, the tab is hidden.

**Key behavior**: The tree shows the complete family, not just one task's history. Branching doesn't stop the parent — the parent's turns continue below the branch point while child tasks run in parallel. You can branch from branches (grandchildren), creating arbitrarily deep trees.

**Structure**: The tree root is the original (oldest ancestor) task. Each node is a turn (message pair). Branch points show where child tasks diverge. Parent turns continue past branch points.

```
Task: "Implement auth" (original)                    ← root
├─ Turn 0: "Add login endpoint"
├─ Turn 1: "Add JWT validation"
├─ Turn 2: "Add rate limiting"                        ← branch point
│  ├─ Branch A: "Distributed approach" (failed ✗)     ← child task
│  │  ├─ Turn 0: "Add Redis cluster"
│  │  └─ Turn 1: "Got stuck on config"
│  └─ Branch B: "Simple bucket" (done ✓)              ← child task
│     ├─ Turn 0: "In-memory token bucket"
│     ├─ Turn 1: "Add tests"                          ← nested branch point
│     │  └─ Branch C: "Property-based tests"          ← grandchild task
│     │     └─ Turn 0: "QuickCheck-style props"
│     └─ Turn 2: "Done"
├─ Turn 3: "Original continued here"                  ← parent kept going
└─ Turn 4: "Add middleware"
```

**Full family resolution**: Calling the tree endpoint from *any* task in the family returns the same complete tree. The API walks `parent_task_id` up to the root (the task with no parent), then recursively collects all descendants via `parent_task_id` + `branched_from_checkpoint_id` to place each branch at the correct turn. This means you always see the full picture regardless of which task you're currently viewing.

**Interaction**:
- Click any node → navigates to that message in the conversation view (cross-task navigation)
- Current task's turns are highlighted/bold; other tasks' turns are dimmed
- Branch points highlighted with a fork icon
- Active/running branches show a pulse indicator
- Completed branches show status (done ✓ / failed ✗) with color coding
- Hover on a branch node → tooltip with title, provider, model, status
- Collapse/expand any branch subtree

**Layout**: Vertical tree with indentation, similar to a file explorer. Collapsible branches. The pane fills the same space as Chat/Diff/Terminal/Activity — user switches between them via the tab bar. The current task's position in the tree is auto-scrolled into view on open.

**Data**: Built from `checkpoints` + `tasks` tables. Query: walk `parent_task_id` to root, then collect all descendants. Each task's checkpoints determine turn positions; `branched_from_checkpoint_id` determines where branches attach to their parent's timeline.

**API**:
```
GET /api/tasks/:id/tree
```
Returns the full tree for a task family (walks `parent_task_id` up to root, then down to all descendants). Works from any task in the family — always returns the same complete tree:

```typescript
interface TaskTreeNode {
  taskId: string;
  title: string;
  status: TaskStatus;
  provider: AgentProvider;
  model?: string;
  turns: {
    turnIndex: number;
    checkpointId: string;
    lastMessage: string;        // truncated preview
    branches: TaskTreeNode[];   // child tasks branching from this turn (recursive)
  }[];
}
```

The recursive `TaskTreeNode` structure supports arbitrary depth — branches of branches of branches. The UI renders this recursively with increasing indentation.

## Shared Types

```typescript
// packages/shared/src/types.ts

interface Checkpoint {
  id: string;
  taskId: string;
  sessionLogId: number;
  commitSha: string;
  turnIndex: number;
  createdAt: string;
}

interface BranchRequest {
  checkpointId: string;
  title: string;
  description?: string;
  provider?: AgentProvider;
  model?: string;
  prompt?: string;  // optional initial instruction for the new branch
}

// Add to TaskSource union:
type TaskSource = "github" | "manual" | "cross-project" | "cron" | "branch";

// Add to Task:
interface Task {
  // ...existing fields...
  branchedFromCheckpointId?: string;
}
```

## Implementation Plan

### Phase 1: Checkpoints (backend only)
1. Add `checkpoints` table to schema
2. Add checkpoint creation logic in the agent event pipeline (on `status: idle`)
3. Add `GET /api/tasks/:id/checkpoints` endpoint
4. Add checkpoint cleanup in task completion/cleanup flow

### Phase 2: Branching (backend)
1. Add `branched_from_checkpoint_id` to tasks table
2. Add `"branch"` to `TaskSource` union
3. Implement `POST /api/tasks/:taskId/branch` endpoint
4. Implement conversation prefix builder
5. Wire up worktree initialization from checkpoint commit

### Phase 3: Web UI — Branching & Tree
1. Add "Branch" action to message hover menu
2. Branch creation modal with checkpoint preview
3. Checkpoint indicators in conversation timeline (subtle dot or marker per turn)
4. Task lineage header ("Branched from X at turn N")
5. Conversation tree panel — collapsible sidebar showing full task family tree
6. Cross-task navigation from tree nodes to conversation view
7. `GET /api/tasks/:id/tree` endpoint returning `TaskTreeNode` structure

### Phase 4: Polish
1. Context window management (truncation/summarization)
2. Checkpoint TTL and garbage collection
3. Tree panel keyboard navigation and search

## Non-Goals (v0)

- **Perfect state restoration**: We don't try to restore provider-internal state. The agent gets context, not its exact prior session.
- **Reversing side effects**: PRs, pushed commits, API calls made before the branch point are not undone.
- **Live branch switching**: You can't "switch" a running agent to a different branch mid-conversation. You create a new task.
- **Merging branches**: No mechanism to merge insights from two branches back together. That's a workflow concern, not a platform feature.
- **Cross-task branching**: Branching from task A into task B's worktree. Each branch is independent.

## Open Questions

1. **Should checkpoints be opt-in or always-on?** Auto-checkpointing is simple but creates commits even when branching is never used. Could gate behind a project config flag. Recommendation: always-on — the cost is negligible and the value is high when you need it.

2. **Provider-specific replay?** Claude Code supports `--resume` which could give better context restoration than replay. Should we use it when available? Recommendation: start with uniform replay, optimize per-provider later.

3. **Checkpoint granularity?** Currently: one per agent idle. Alternative: checkpoint after every user message (before agent responds). The idle-based approach is simpler and captures the complete turn including file changes.
