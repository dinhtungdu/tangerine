# Unified Dashboard

Single entry point for all projects. The user sees one dashboard with all tasks across all projects — no project selection gate.

## Problem

The current dashboard requires picking a project before you can do anything. With N projects, the user must know which project to interact with before starting. This creates friction and a mental model of "project first, then work" instead of "here's everything, talk to what you need."

Competitive landscape (Superset, Emdash, cmux, Craft Agents) shows two sidebar patterns — nested (projects → tasks) and flat (everything in one list). None of them have an AI orchestrator. Tangerine's per-project orchestrator is the differentiator, but the UX shouldn't force the user to think about the architecture.

## Design

### Mental model

**"Here are all my agents. Some delegate, some code. I talk to whichever one I need."**

The user sees a flat list of all tasks. Orchestrators and workers live in the same list. The project is metadata on a task, not a navigation level.

### Sidebar

Current: project-scoped. Orchestrator pinned at top, workers below. Must select project first.

New:

```
┌─────────────────────────┐
│ [+ New]  [Search...]    │
├─────────────────────────┤
│ ORCHESTRATORS           │
│  ● tangerine        idle│
│  ● orange        working│
├─────────────────────────┤
│ [Active ▾]  [All ▾]    │
│ RUNS                    │
│  ● fix auth bug    🟢  │
│    tangerine · sonnet   │
│  ● update schema   🟡  │
│    orange · opus        │
│  ● add cron UI     🔵  │
│    tangerine · sonnet   │
└─────────────────────────┘
```

Key changes:
- **Default view: all projects** — no project gate
- **Orchestrators section**: one row per project, always visible, labeled by project name. Clicking creates/navigates to that project's orchestrator (lazy-create, same as today).
- **Runs section**: all workers/reviewers across projects, flat list. Each shows project name as a subtle tag.
- **Project filter**: optional — dropdown or toggle to narrow both sections to one project. Default is "All."
- **Search**: works across all projects.

### Project filter (replaces ProjectSwitcher)

The current `ProjectSwitcher` in the topbar becomes a filter, not a gate:

- Default: "All Projects"
- Selecting a project filters sidebar and runs to that project only
- Does NOT change the URL structure — just filters the view
- Archived projects hidden from filter unless explicitly shown

### Orchestrator interaction

No change to orchestrator behavior. Per-project orchestrators stay as-is:
- One active per project (enforced)
- Runs on default branch, slot 0
- Lazy-created on first click
- Idle suspension after 10 min
- Chained via `parentTaskId` on restart

The only UX change: orchestrators appear as rows in the sidebar labeled by project name, not as a single "Middle Manager" button scoped to the current project.

### Starting new work

Two paths:

1. **Talk to an orchestrator**: click its row in the sidebar → opens the orchestrator's chat → tell it what you want → it delegates to workers. This is the primary path for complex/multi-step work.

2. **Create a worker directly**: click "+ New" → same new-run form as today, but with project selection inline (dropdown in the form, not a prerequisite). This is for one-off tasks where orchestrator delegation is overkill.

### Task detail

No changes. Task detail page stays the same — chat panel, diff viewer, terminal pane, capability-gated UI.

### What doesn't change

- Orchestrator lifecycle (creation, suspension, restart, chaining)
- Worker behavior (worktrees, branches, providers)
- Cross-project API
- Task types and capabilities
- Backend API routes

## Implementation

### Backend

Minimal changes:

1. **Task list API**: `GET /api/tasks` already supports `?projectId=` filter. Ensure it returns all tasks when no filter is set (verify current behavior).
2. **Orchestrator list**: new convenience endpoint or extend existing — `GET /api/orchestrators` returning all active orchestrators across projects. Alternative: client filters from task list where `type=orchestrator`.

### Frontend

1. **`ProjectContext`**: change default from "first project" to "all projects" (null = all). The `?project=` query param becomes optional — absent means all.

2. **`TasksSidebar`**:
   - Remove orchestrator-specific button at top
   - Add orchestrators section showing one row per project (from task list where `type=orchestrator`, plus un-created orchestrators from project config)
   - Runs section shows all non-orchestrator tasks, each with project tag
   - Filter by project when `ProjectContext` has a selection

3. **`ProjectSwitcher`** (topbar): rename concept to "project filter." Default option: "All Projects." Selecting filters sidebar + runs page. No URL change.

4. **`RunsPage`**: show tasks across all projects when no filter. Add project column/tag to runs table rows.

5. **`NewAgentPage`**: project selection moves into the form as a required field (dropdown), instead of being inherited from the global project context.

### Migration

- No database changes
- No API breaking changes
- Feature flag: not needed — this is a UX-only change with the same underlying data

## Rejected alternatives

### Single global orchestrator

Replace per-project orchestrators with one project-unbound orchestrator. Rejected because:
- Loses project context (the orchestrator can't read code, understand conventions)
- Context window saturation when managing multiple projects
- The research literature (Anthropic's multi-agent blog, SOTA frameworks) converges on per-domain orchestrators for exactly this reason

### Global router + per-project orchestrators

Thin routing agent that forwards requests to the right project orchestrator. Rejected because:
- Adds latency (LLM must interpret intent before work starts)
- Adds a new task type and concept for minimal UX gain
- The sidebar already solves routing — user clicks the project orchestrator they want

### Remove orchestrators entirely

Make the human the orchestrator (like Superset, Emdash, cmux). Rejected because:
- The AI orchestrator is Tangerine's differentiator
- Human orchestration doesn't scale to many parallel tasks
- Orchestrators already work well — the problem is UX surface, not the concept

## Open questions

1. **Orchestrator row for uncreated orchestrators**: should the sidebar show a row for projects that don't have an active orchestrator yet? (Probably yes — clicking creates one, same as today's button.)
2. **Notification/status indicators**: should orchestrators show unseen-activity badges like workers do? Would help with "which orchestrator needs my attention" in the all-projects view.
3. **Cross-project orchestrator awareness**: should the orchestrator system prompt mention all configured projects, not just its own? Would let it suggest creating tasks in other projects when relevant.
