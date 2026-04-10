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

New: flat task list across all projects. No orchestrator section — orchestrators are in the list like any other task.

**Default view — "All Projects":**

```
┌─────────────────────────────┐
│ [+ New]  [Search...]        │
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │ All Projects        ▾   │ │
│ └─────────────────────────┘ │
├─────────────────────────────┤
│ ACTIVE RUNS              3  │
├─────────────────────────────┤
│ ● fix auth bug          🟢 │
│   tangerine · sonnet        │
│ ● update schema         🟡 │
│   orange · opus             │
│ ● add cron UI           🔵 │
│   tangerine · sonnet        │
└─────────────────────────────┘
```

**Filtered to a project (click project in dropdown):**

Selecting a project in the dropdown does two things:
1. Filters the sidebar to that project's tasks
2. Opens that project's orchestrator chat in the main panel

```
┌─────────────────────────────┐
│ [+ New]  [Search...]        │
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │ tangerine           ▾   │ │
│ └─────────────────────────┘ │
├─────────────────────────────┤
│ ACTIVE RUNS              2  │
├─────────────────────────────┤
│ ● fix auth bug          🟢 │
│   sonnet                    │
│ ● add cron UI           🔵 │
│   sonnet                    │
└─────────────────────────────┘
```

The main panel shows the tangerine orchestrator chat — ready to receive instructions. The orchestrator is lazy-created on first project selection if it doesn't exist yet.

Key changes:
- **Default view: all projects** — no project gate
- **No orchestrator section** — orchestrators don't clutter the sidebar. They're accessed via the project dropdown.
- **Project dropdown is dual-purpose**: filter + orchestrator launcher. Selecting a project opens its orchestrator AND filters the sidebar. Selecting "All Projects" returns to the full list.
- **Runs list**: flat, all projects. Each task shows project name as a subtle tag (hidden when filtered to one project since it's redundant).
- **Search**: works across all projects.

### Project dropdown (replaces ProjectSwitcher)

The current `ProjectSwitcher` becomes a dual-purpose control:

- Default: "All Projects" — shows everything, no orchestrator open
- Selecting a project: filters sidebar to that project AND opens its orchestrator chat
- Selecting "All Projects" again: returns to unfiltered view
- Archived projects hidden unless explicitly shown
- Does NOT change the URL structure — just filters the view and navigates to orchestrator

This solves the "20 projects = 20 orchestrator rows" problem. The dropdown scales to any number of projects. One click to focus on a project and talk to its brain.

### Orchestrator interaction

No change to orchestrator behavior. Per-project orchestrators stay as-is:
- One active per project (enforced)
- Runs on default branch, slot 0
- Lazy-created on first project selection (if no active orchestrator exists)
- Idle suspension after 10 min
- Chained via `parentTaskId` on restart

The UX change: orchestrators are accessed by selecting a project in the dropdown, not by clicking a dedicated sidebar button. The project dropdown is the entry point to talk to any project's orchestrator.

### Starting new work

Two paths:

1. **Talk to an orchestrator**: select a project in the dropdown → orchestrator chat opens in main panel → tell it what you want → it delegates to workers. This is the primary path for complex/multi-step work.

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
   - Move project dropdown into the sidebar (from topbar)
   - Runs section shows all non-orchestrator tasks across projects, each with project tag (hidden when filtered to one project)
   - Filter by project when dropdown has a selection

3. **Project dropdown** (in sidebar): dual-purpose control. "All Projects" shows everything. Selecting a project filters sidebar AND navigates to that project's orchestrator (lazy-create via `ensureOrchestrator` if needed).

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

### Rejected: dedicated orchestrator section in sidebar

One row per project in a pinned "Orchestrators" section. Rejected because it doesn't scale — 20 projects means 20 permanent rows. The project dropdown solves this: one control, scales to any number of projects, and doubles as the orchestrator launcher.

## Open questions

1. **Notification/status indicators**: should the project dropdown show a badge when an orchestrator needs attention? (e.g., small dot next to "tangerine" in the dropdown when its orchestrator has unseen activity.)
2. **Cross-project orchestrator awareness**: should the orchestrator system prompt mention all configured projects, not just its own? Would let it suggest creating tasks in other projects when relevant.
3. **"All Projects" main panel**: when no project is selected, what does the main panel show? Options: empty state with instructions, a feed of recent activity across projects, or the last-viewed task.
