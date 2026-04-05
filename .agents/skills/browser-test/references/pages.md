# Dashboard Route Map

Routes for the Tangerine web dashboard. Use this to decide which pages to screenshot after a change.

## Routes

| Route | Page | Component | What to verify |
|-------|------|-----------|----------------|
| `/` | Runs | `RunsPage` | Task list, status badges, filters, activity indicators |
| `/new` | New Agent | `NewAgentPage` | Form fields, project selector, provider options |
| `/status` | Status | `StatusPage` | System health, agent status, worktree pool |
| `/tasks/:id` | Task Detail | `TaskDetail` | Activity feed, messages, diff view, status transitions |

## Layout

All routes render inside `<Layout />` which provides:
- Sidebar navigation
- Project selector (via `ProjectContext`)
- Header with status indicators

## What to screenshot based on change location

| Files changed in... | Screenshot these routes |
|---------------------|----------------------|
| `web/src/pages/RunsPage*` | `/` |
| `web/src/pages/NewAgentPage*` | `/new` |
| `web/src/pages/StatusPage*` | `/status` |
| `web/src/pages/TaskDetail*` | `/tasks/:id` (use a real task ID from the API) |
| `web/src/components/Layout*` | `/` and one other page (to verify layout across routes) |
| `web/src/components/Sidebar*` | `/` (sidebar is visible on all pages) |
| `web/src/components/*Card*` or `*Row*` | `/` (cards and rows appear on the runs page) |
| `web/src/components/*Dialog*` or `*Modal*` | The page that triggers the dialog — open it via `click` before screenshotting |
| `web/src/context/*` or `web/src/lib/*` | `/` plus any page that consumes the changed context/utility |
| General styling / theme changes | `/` and `/tasks/:id` (cover list and detail views) |

## Getting a real task ID for screenshots

If you need to screenshot `/tasks/:id`, fetch a task ID from the API:

```bash
TASK_ID=$(curl -s http://localhost:3456/api/tasks?status=running | jq -r '.[0].id // empty')
if [ -z "$TASK_ID" ]; then
  TASK_ID=$(curl -s http://localhost:3456/api/tasks | jq -r '.[0].id // empty')
fi
```

If no tasks exist, screenshot `/` instead — the task detail page requires data to be meaningful.
