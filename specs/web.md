# Web Dashboard

The web app is a Vite + React SPA under `web/src/`. It is served by the API server in production and can run separately in development.

## Routes

| Route | Purpose |
|------|---------|
| `/` | Runs page |
| `/new` | New run form |
| `/status` | System status page |
| `/tasks/:id` | Task detail view |

## Main Screens

### Runs Page

Implemented in `pages/RunsPage.tsx`.

Current behavior:

- project switcher
- search/filter over tasks
- orchestrator launcher / entry row
- runs table for non-orchestrator tasks
- SSH editor deep-link on task cards (when configured)
- new-run navigation

### New Run Page

Implemented in `pages/NewAgentPage.tsx`.

Current controls include:

- project selection
- harness/provider selection
- model selection
- reasoning-effort selection
- branch / PR reference input
- task type selection

### Task Detail

Implemented in `pages/TaskDetail.tsx`.

Current task-detail feature set includes:

- chat panel
- streamed messages
- tool call display
- diff / changes panel
- terminal pane
- pane controls and resizing
- image lightbox support
- SSH editor deep-link ("Open in {editor}") — shown when `sshHost` and `editor` are configured and the task has a worktree

UI gating is capability-based. The client should check `task.capabilities.includes(...)` rather than infer behavior from a task title.

### Status Page

Implemented in `pages/StatusPage.tsx`.

Current sections:

- active runs summary
- project update status / update action
- predefined prompt editors for worker, orchestrator, and reviewer prompts
- system log viewer

## State and Data Flow

- project context comes from `context/ProjectContext.tsx`
- task lists and filtering come from hooks in `web/src/hooks/`
- API access is centralized in `web/src/lib/api.ts`
- per-task streaming uses WebSocket hooks

## Shared Components

Key components include:

- `RunsTable`
- `TasksSidebar`
- `ChatPanel`
- `TerminalPane`
- `ChangesPanel`
- `ModelSelector`
- `HarnessSelector`
- `ReasoningEffortSelector`
- `PredefinedPromptsEditor`

## Testing

Current test buckets under `web/src/__tests__/`:

- `architecture.test.ts`
- `components.test.tsx`
- `hooks.test.tsx`
- `lib.test.ts`

The architecture test enforces structural constraints such as:

- no mobile-only component files
- no inline component definitions in pages
- no JS viewport detection
