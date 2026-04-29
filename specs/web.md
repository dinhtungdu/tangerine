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
- task list grouped by project
- SSH editor deep-link on task cards (when configured)
- new-run navigation

### New Run Page

Implemented in `pages/NewAgentPage.tsx`.

Current controls include:

- `#` task mentions and `@` file mentions in prompt textareas
- project selection
- harness/provider selection
- model selection
- reasoning-effort selection
- ACP mode selection when the active session exposes a `mode` config option
- branch / PR reference input
- task type selection

### Task Detail

Implemented in `pages/TaskDetail.tsx`.

Current task-detail feature set includes:

- chat panel
- `#` task mentions, `@` file mentions, and `/` slash-command autocomplete in prompt textareas
- streamed messages
- no-`messageId` ACP narration updates rendered as compact Narration cards with separate timestamps
- streamed thinking preserved as ordered Thought cards; contiguous deltas for one provider segment merge, but messageId changes, visible interleaving events, and no-`messageId` sentence boundaries start separate cards
- tool activity tracked in the activity stream and used for compact streaming status; raw tool call cards are suppressed from the chat transcript
- ACP config-option selectors for `model`, `thought_level`/`effort`, and `mode`; legacy ACP `models` / `modes` state is normalized into the same UI, with legacy thinking/reasoning modes shown as `thought_level`
- ACP harness support summary in the selector popover, showing which of Model, Effort, and Mode are advertised for the active session
- ACP plan cards
- ACP content-block cards, including resource, diff, and terminal blocks
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
- predefined prompt editors for worker, runner, and reviewer prompts
- editable queued prompt cards shown while the agent is working
- system log viewer

## State and Data Flow

- project context comes from `context/ProjectContext.tsx`
- task lists and filtering come from hooks in `web/src/hooks/`
- API access is centralized in `web/src/lib/api.ts`
- per-task streaming uses WebSocket hooks
- runs/sidebar task data loads from REST initially, then listens to `/api/tasks/list/ws` task-change invalidations and agent-status updates; it refetches on reconnect/visibility rather than interval polling
- initial task-detail load uses `/api/tasks/:id/messages`, which includes persisted logs plus any transient active assistant/thinking stream so switching into a running task shows current output immediately
- ACP `config.options`, `slash.commands`, `thinking.streaming`, `thinking.complete`, `plan`, and `content.block` events are folded into per-task session state
- activity REST snapshots merge with WebSocket activity updates by id/freshness so stale fetch responses cannot overwrite live tool progress
- queued prompts come from `queue` WebSocket messages plus `/api/tasks/:id/queue` REST fallback; edits/removals call queue REST routes; queued prompts stay in the queue UI, not the transcript, until delivered to the agent

## Shared Components

Key components include:

- `RunsTable`
- `TasksSidebar`
- `ChatPanel`
- `TerminalPane`
- `ChangesPanel`
- `HarnessSelector`
- `ModelEffortPopover`
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
