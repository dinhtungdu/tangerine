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

### Claude Code's native worktree fix doesn't apply

Claude Code v2.1.50 (Feb 2026) added native worktree sharing — "project configs & auto memory are now shared across git worktrees of the same repository" ([anthropics/claude-code#34437](https://github.com/anthropics/claude-code/issues/34437), [anthropics/claude-code#24382](https://github.com/anthropics/claude-code/issues/24382)). However, this fix **does not work for Tangerine's worktrees** because:

1. Claude Code detects worktrees using `git rev-parse --git-common-dir` at CLI startup
2. Tangerine spawns Claude Code with `--dangerously-skip-permissions` and `--output-format stream-json` — the process lifecycle is managed by Tangerine, not the user
3. Even on Claude Code v2.1.91, `~/.claude/projects/` still shows separate directories per worktree slot (`-tangerine-0/`, `-tangerine-1/`, `-tangerine-2/`, etc.)
4. The fix may only apply to worktrees Claude Code creates itself (via `--worktree` / `EnterWorktree`)

This means Tangerine must handle memory sharing independently.

## Prior art & SOTA

### Academic foundations

The survey ["Memory in the Age of AI Agents"](https://arxiv.org/abs/2512.13564) (Dec 2025, updated Jan 2026) provides the canonical taxonomy:

**Memory forms** (what carries it):
- **Token-level**: Explicit, editable text units (e.g., CLAUDE.md, conversation logs). Transparent, auditable. This is what we use.
- **Parametric**: Embedded in model weights (fine-tuning). Not applicable for our multi-provider setup.
- **Latent**: Continuous vectors / KV-cache states. High density but opaque.

**Memory functions** (why agents need it):
- **Factual**: Knowledge-based — "the DB uses SQLite", "API returns `{ data, error }`"
- **Experiential**: How to solve problems — divided into case-based (raw trajectories), strategy-based (abstracted workflows), and skill-based (executable code/tools)
- **Working**: Active context for the current task

**Memory dynamics** (how it evolves):
- Formation → consolidation → retrieval → decay
- Episodic → semantic conversion (specific incidents → general knowledge)

Our system maps cleanly: `architecture`/`decision`/`pattern` = factual, `learning` = experiential (case-based), `context` = working memory.

### Production memory systems

| System | Architecture | Key insight | Benchmark |
|--------|-------------|-------------|-----------|
| **[Mem0](https://mem0.ai/)** | Vector + graph + KV multi-store, async writes, scoped (user/session/agent) | Universal memory layer — 48k GH stars. Async-by-default prevents memory writes from blocking responses. | +26% over OpenAI Memory on LOCOMO |
| **[Zep / Graphiti](https://www.getzep.com/)** | Temporal knowledge graph with validity windows per fact (when facts became true, when superseded) | Time-aware memory — facts have temporal ranges, enabling "what did we believe at time T?" queries. Built on Neo4j. | +18.5% accuracy, 90% lower latency on LongMemEval |
| **[Letta (MemGPT)](https://docs.letta.com/)** | OS-inspired tiered memory: core (RAM) ↔ recall/archival (disk). Agent self-manages paging. | LLM-as-OS paradigm — agent decides what to keep in context vs. store to disk, like virtual memory paging. | Pioneered the DMR benchmark |
| **[Supermemory](https://supermemory.ai/)** | Agentic retrieval (3 parallel observer agents) replacing vector search. 6 extraction vectors. | Ditching embeddings for active search agents was the single biggest unlock — eliminates "semantic similarity trap." | ~99% on LongMemEval_s |
| **[Mastra Observational Memory](https://mastra.ai/docs/memory/observational-memory)** | Observer + Reflector background agents compress conversation into dated observations | 3-6x text compression, 5-40x for tool-heavy workloads. Two-block context window. | SOTA on LongMemEval |
| **[A-Mem](https://arxiv.org/abs/2502.12110)** (NeurIPS 2025) | Zettelkasten-inspired interconnected notes with auto-linking and structured attributes | Agent-driven memory organization — memories evolve via new experiences. | 2x on multi-hop reasoning |
| **[LangMem](https://langchain-ai.github.io/langmem/)** | SDK for memory extraction, prompt optimization, namespaced storage | Three memory types mapped to human cognition: semantic (facts), episodic (experiences), procedural (rules → prompt updates) | — |
| **[ODEI](https://github.com/odei-ai)** | Constitutional knowledge graph, 7 policy layers before every write | Governance-first: typed/auditable graph with policy-gated writes for production safety. | — |

### Parallel agent platforms

| Tool | Memory approach |
|------|----------------|
| **[Conductor](https://docs.conductor.build/)** | No shared memory — agents coordinate via spawn prompt + CLAUDE.md/AGENTS.md |
| **[Superset](https://superset.sh/)** | No shared memory — each agent gets own worktree, conflicts surface at merge time |
| **Claude Code Agent Teams** | Shared task list, but warns "two teammates editing same file leads to overwrites" |

**Key gap**: No existing parallel agent tool has a proper shared memory layer. They all rely on static context files (CLAUDE.md) or expect agents to figure it out at merge time. This is an opportunity for Tangerine.

### Design implications from research

1. **Async memory writes** (Mem0): Memory saves should never block the agent's response pipeline. Our API-based approach (Layer 2) naturally satisfies this — agents fire-and-forget POST calls.
2. **Temporal validity** (Zep/Graphiti): Memories should track when they became true and when they were superseded. Our `supersedes` field + `created_at`/`updated_at` timestamps provide this. The `context` type with `expires_at` adds temporal decay.
3. **Observational compression** (Mastra/Supermemory): For auto-capture (Phase 5), use an Observer pattern — a lightweight post-task pass that compresses session logs into structured memories. Supermemory's finding that agentic retrieval beats vector search validates our approach of structured type-based filtering over embedding similarity.
4. **Tiered memory** (Letta/MemGPT): Our design naturally tiers: Layer 1 (symlinks) = core/working memory (always available), Layer 2 (DB) = recall memory (queried on demand), Layer 3 (injection) = the paging mechanism that loads recall into working memory.
5. **Interconnected notes** (A-Mem): Memories should link to related memories via tags and `supersedes` field. The Zettelkasten principle of building connections between notes produces better retrieval than flat lists.
6. **Episodic → semantic consolidation** (survey taxonomy): Individual task learnings (episodic: "bun:test failed because of X") should consolidate into general patterns (semantic: "always use module-level mocking with bun:test"). Phase 5 auto-capture should drive this consolidation.
7. **Procedural memory as prompt updates** (LangMem): Learnings about _how_ to work (coding conventions, review patterns) should update the agent's system prompt, not just be stored as facts. Our prompt injection (Layer 3) enables this — procedural memories can be formatted as instructions.
8. **Governance layers** (ODEI): For multi-agent setups, memory writes need conflict resolution — two agents shouldn't create contradictory memories. The `supersedes` field and deduplication check handle this.

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

### E. Mem0 / external memory framework

Mem0 offers a production-grade universal memory layer with vector + graph + KV stores. However, integrating it adds external dependencies (Python, vector DB), infrastructure complexity, and a semantic mismatch — Mem0 is designed for conversational memory (user preferences, facts about users), not coding agent project memory (architecture decisions, code patterns, build gotchas). Our SQLite-based approach is simpler, self-contained (Bun + SQLite, no external services), and purpose-built for the coding agent use case. If memory volume scales beyond hundreds of entries per project, we can add vector search later.

### F. Observational memory (Mastra-style)

The Observer/Reflector pattern achieves impressive compression (5-40x for tool-heavy workloads) but is designed for single-agent long conversations, not multi-agent cross-session memory. Our problem is different — we need to share learnings _between_ agents, not compress one agent's history. However, the observation pattern is valuable for Phase 5 auto-capture: use a lightweight post-task extraction pass to compress session logs into structured memories.

### G. MCP memory server

An MCP server could expose memory read/write as tools available to all providers. This has the advantage of being provider-native (agents call it like any other tool). However:
- Requires MCP configuration per worktree per provider
- Adds process overhead (separate server per project)
- Not all providers support MCP equally

The API approach (Layer 2) achieves the same result more simply via HTTP. MCP could be added as an optional frontend to the same backing store if provider MCP support matures.

## References

### Surveys & taxonomy
- [Memory in the Age of AI Agents: A Survey (Dec 2025)](https://arxiv.org/abs/2512.13564) — canonical taxonomy of forms, functions, and dynamics
- [State of AI Agent Memory 2026 (Mem0)](https://mem0.ai/blog/state-of-ai-agent-memory-2026) — industry landscape overview
- [ODEI vs Mem0 vs Zep: Choosing Agent Memory Architecture in 2026](https://dev.to/zer0h1ro/odei-vs-mem0-vs-zep-choosing-agent-memory-architecture-in-2026-15c0)

### Research papers
- [A-MEM: Agentic Memory for LLM Agents (NeurIPS 2025)](https://arxiv.org/abs/2502.12110)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)
- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)

### Production systems
- [Mem0 — Universal memory layer](https://mem0.ai/)
- [Zep / Graphiti — Temporal knowledge graphs](https://www.getzep.com/)
- [Letta (MemGPT) — OS-inspired tiered memory](https://docs.letta.com/)
- [Supermemory — Agentic retrieval, ~99% LongMemEval_s](https://supermemory.ai/research/)
- [Mastra Observational Memory](https://mastra.ai/docs/memory/observational-memory)
- [LangMem SDK](https://langchain-ai.github.io/langmem/)

### Claude Code worktree issues
- [anthropics/claude-code#34437 — Worktrees should share project directory](https://github.com/anthropics/claude-code/issues/34437)
- [anthropics/claude-code#24382 — Auto memory should be shared across worktrees](https://github.com/anthropics/claude-code/issues/24382)
- [Claude Code Memory Docs](https://code.claude.com/docs/en/memory)

### Parallel agent tools
- [Parallel Coding Agents (2026): 8 Tools Compared](https://www.morphllm.com/parallel-coding-agents)
- [Conductor — Parallel agent Mac app](https://docs.conductor.build/)
- [Superset — Terminal for parallel coding agents](https://superset.sh/)
