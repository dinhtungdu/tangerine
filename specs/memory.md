# Memory System

Cross-worktree memory sharing for multi-provider agents.

## Problem

Each agent provider maintains its own memory tied to the working directory path:

- **Claude Code**: `~/.claude/projects/{path-hash}/memory/` — path includes worktree slot number
- **OpenCode**: per-directory context files
- **Codex**: thread-based state, no persistent memory
- **Pi**: session-based, no persistent memory

Since Tangerine uses worktree slots (`{workspace}/{project}/0`, `/1`, `/2`, ...), providers treat each slot as a separate project. Memories saved in slot 1 are invisible to slot 2, even for the same project. When a task finishes and a new task reuses the slot, provider behavior is inconsistent — Claude Code retains stale memories from the previous task, while others start fresh.

**Current state**: Only worktree 0 (orchestrator) has accumulated memories. Worker worktrees (1-N) have none.

## Design

Three-layer approach: filesystem unification for native provider memory, a Tangerine-managed memory store for structured cross-provider memory, and prompt injection for providers that lack native memory.

### Layer 1: Provider-native memory unification (symlinks)

Unify provider-specific memory directories so all worktrees share the same memory store per project.

#### Claude Code

Claude Code resolves project memory path from `cwd`:
```
~/.claude/projects/-Users-tung-tangerine-workspace-tangerine-0/memory/
~/.claude/projects/-Users-tung-tangerine-workspace-tangerine-1/memory/  # separate!
```

**Solution**: At worktree acquisition time, symlink each slot's memory dir to slot 0's:

```typescript
// In acquireSlot(), after git reset:
const slot0MemoryDir = `~/.claude/projects/${pathToKey(slot0Path)}/memory`
const slotNMemoryDir = `~/.claude/projects/${pathToKey(slotNPath)}/memory`

// Ensure slot 0's memory dir exists
await fs.mkdir(slot0MemoryDir, { recursive: true })

// Remove slot N's memory dir and symlink to slot 0's
await fs.rm(slotNMemoryDir, { recursive: true, force: true })
await fs.symlink(slot0MemoryDir, slotNMemoryDir)
```

Where `pathToKey` converts `/Users/tung/tangerine-workspace/tangerine/1` → `-Users-tung-tangerine-workspace-tangerine-1` (matching Claude Code's convention: replace `/` with `-`, strip leading `-`).

**Also symlink `settings.local.json`**: Claude Code's per-project settings (model preferences, allowed tools) should also be shared:

```typescript
const slot0Settings = `~/.claude/projects/${pathToKey(slot0Path)}/settings.local.json`
const slotNSettings = `~/.claude/projects/${pathToKey(slotNPath)}/settings.local.json`
if (await fs.exists(slot0Settings)) {
  await fs.rm(slotNSettings, { force: true })
  await fs.symlink(slot0Settings, slotNSettings)
}
```

#### OpenCode

OpenCode reads `.opencode/` from the working directory. Since worktrees share the git tree (minus branch), project-level config in `.opencode/` is already shared if committed. For non-committed context, symlink `.opencode/memory/` similarly.

#### Codex & Pi

No filesystem-based memory. Handled by Layer 2 + 3.

### Layer 2: Tangerine-managed memory store

A centralized, provider-agnostic memory store in SQLite. Agents read/write via the Tangerine API.

#### Schema

```sql
CREATE TABLE IF NOT EXISTS project_memories (
  id TEXT PRIMARY KEY,                          -- nanoid
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,                           -- architecture | decision | pattern | learning | context
  title TEXT NOT NULL,                          -- short summary for index
  content TEXT NOT NULL,                        -- full memory content (markdown)
  source_task_id TEXT,                          -- which task created this
  source_provider TEXT,                         -- which provider created this
  tags TEXT,                                    -- JSON array for filtering
  supersedes TEXT,                              -- id of memory this replaces (for updates)
  active INTEGER NOT NULL DEFAULT 1,            -- soft delete / superseded flag
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (source_task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_project_memories_project ON project_memories(project_id, active);
CREATE INDEX IF NOT EXISTS idx_project_memories_type ON project_memories(project_id, type, active);
```

#### Memory types

| Type | Purpose | Example |
|------|---------|---------|
| `architecture` | How the system is structured | "Auth middleware uses JWT with refresh tokens stored in httpOnly cookies" |
| `decision` | Why something was done a certain way | "Chose SQLite over Postgres for v0 — single-machine deployment, no ops overhead" |
| `pattern` | Recurring code patterns or conventions | "All API routes return `{ data, error }` shape, never throw" |
| `learning` | Bug fixes, gotchas, non-obvious behavior | "bun:test doesn't support `jest.mock` — use module-level mocking instead" |
| `context` | Current state, ongoing work, temporary notes | "Migration from REST to tRPC in progress — both coexist until Q2" |

#### API endpoints

```
GET    /api/projects/:id/memories                 — list active memories (with ?type= filter)
POST   /api/projects/:id/memories                 — create memory
PATCH  /api/projects/:id/memories/:memoryId       — update memory
DELETE /api/projects/:id/memories/:memoryId        — soft-delete (set active=0)
GET    /api/projects/:id/memories/context          — get injection-ready context (formatted for prompt)
```

**Context endpoint** returns all active memories formatted as a single markdown block, ready for prompt injection:

```markdown
## Project Memory

### Architecture
- Auth middleware uses JWT with refresh tokens in httpOnly cookies
- WebSocket connections are per-task, not per-user

### Decisions
- SQLite over Postgres for v0 (single-machine, no ops)

### Learnings
- bun:test doesn't support jest.mock — use module-level mocking
```

#### Agent write access

Agents already have `TANGERINE_TASK_ID` env var. Add `TANGERINE_API_URL` (defaults to `http://localhost:3456`). Agents can write memories via:

```bash
curl -X POST $TANGERINE_API_URL/api/projects/$PROJECT_ID/memories \
  -H "Content-Type: application/json" \
  -d '{"type":"learning","title":"...","content":"..."}'
```

For Claude Code agents, expose this through the `tangerine-tasks` skill — add a `/memory` command.

### Layer 3: Prompt injection

For providers without native memory (Codex, Pi) or as a universal baseline, inject project memories into the agent's initial prompt.

#### Injection point

In `lifecycle.ts`, before sending the first prompt to the agent:

```typescript
// After agent starts, before first prompt
const memories = await fetch(`${API_URL}/api/projects/${task.projectId}/memories/context`)
const memoryContext = await memories.text()

// Prepend to the task prompt
const fullPrompt = memoryContext
  ? `${memoryContext}\n\n---\n\n${task.description}`
  : task.description
```

This works uniformly across all providers since they all receive prompts through the same `AgentHandle.sendPrompt()` interface.

#### For Claude Code specifically

Claude Code also reads `CLAUDE.md` from the working directory. Since `CLAUDE.md` is committed to the repo and shared across worktrees via git, it already serves as a form of shared memory. The Tangerine memory system complements it with runtime, non-committed knowledge.

Optionally, Tangerine can generate a `.tangerine/memory.md` file in each worktree at acquisition time, containing the current memory snapshot. This gives Claude Code's auto-memory system something to read even without API calls.

### Layer 4: Memory lifecycle

#### Auto-capture from agent output

Parse agent completion messages for memory-worthy content. When a task completes, the orchestrator (or a post-task hook) can review the session logs and extract learnings:

```typescript
// Post-task hook in lifecycle.ts
async function extractMemories(task: Task, sessionLogs: SessionLog[]) {
  // Look for patterns:
  // - Bug fixes (what was wrong, why)
  // - Architecture decisions made during implementation
  // - Failed approaches (what didn't work)
  // This can be done by prompting the orchestrator or a dedicated extraction pass
}
```

This is a future enhancement — v0 focuses on manual memory creation via API and symlink-based sharing.

#### Memory decay

Memories of type `context` should have an optional `expires_at` field. A periodic cleanup job marks expired memories as inactive. Other types (architecture, decision, pattern, learning) are long-lived and only superseded manually.

#### Deduplication

When creating a memory, check for existing memories with similar titles in the same project. The API returns potential duplicates in the response so the caller can decide to update instead of create.

## Implementation plan

### Phase 1: Symlink unification (immediate value, low effort)

1. Add `setupMemorySymlinks(projectId, slotPath, slot0Path)` to `worktree-pool.ts`
2. Call it in `acquireSlot()` after git reset
3. Handle Claude Code's path-to-key conversion
4. Symlink both `memory/` dir and `settings.local.json`

**Result**: All Claude Code agents in any worktree share the same memory. Zero provider changes needed.

### Phase 2: Memory DB + API

1. Add `project_memories` table to schema
2. Add CRUD API routes
3. Add `/memories/context` endpoint for formatted output
4. Add `TANGERINE_API_URL` to agent env vars

### Phase 3: Prompt injection

1. Fetch memory context at session start
2. Prepend to initial prompt in `startSession()`
3. Works for all providers uniformly

### Phase 4: Memory management UI

1. Memory list/edit page in web dashboard per project
2. Create/edit/delete memories
3. View which task created each memory
4. Filter by type and tags

### Phase 5: Auto-capture (future)

1. Post-task memory extraction
2. Orchestrator-driven learning aggregation
3. Memory decay for temporal context

## Alternatives considered

### A. Single shared worktree directory for all provider configs

Rejected: too invasive, breaks provider-specific session isolation (sessions should be per-task, not shared).

### B. Custom MCP server for memory

Could work but adds complexity. Providers would need MCP configured per-worktree. The symlink approach is simpler and works with existing provider features. MCP could be a future enhancement for structured memory queries.

### C. Git-committed memory files

Partially adopted: `CLAUDE.md` is already committed and shared. But runtime learnings shouldn't pollute the repo with commits. The DB + symlink approach keeps runtime memory separate from version-controlled project docs.

### D. Embedding-based semantic search

Over-engineered for v0. The memory set per project is small enough (tens to low hundreds) that a simple type-based filter + full-text is sufficient. Embeddings could be added later if memory volume grows.
