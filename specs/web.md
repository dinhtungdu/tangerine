# Web Dashboard

Vite + React SPA. Task list, chat with agent, live preview, provider selection.

## Pages

### Dashboard (`/`)

Task list with real-time status, provider indicator, project context.

Features:
- Real-time status updates (poll or WebSocket)
- Filter by status
- Click task → task detail view
- Shows source (GitHub issue link)
- Shows PR URL when available
- Provider badge per task (OpenCode / Claude Code)
- New task form with provider dropdown

### Task Detail (`/tasks/:id`)

Split view: chat + preview + activity log.

#### Chat Panel

- Message history (scrollable)
- User messages vs agent responses (different styling)
- Tool call display (file edits, shell commands, results)
- Streaming tokens (live typing effect)
- Input box with send button
- Abort button (visible when agent is working)
- Queue indicator (shows pending prompts)

#### Preview Panel

- iframe loading `http://localhost:<api-port>/preview/<task-id>/`
- Refresh button
- Open in new tab link
- Resizable split

#### Activity Log

- Lifecycle events (VM acquired, worktree created, agent started, etc.)
- Filterable by type (lifecycle, file, system)

## Provider Selection

Task creation UI includes a provider dropdown:
- **OpenCode** (default) — OpenCode server mode via SSE
- **Claude Code** — Claude CLI via stdin/stdout NDJSON

Default comes from project's `defaultProvider` config field.

## VM Summary

Dashboard shows VM status per project:
- Active VMs with IP, provider, creation time
- Destroy VM action
- Pool stats (provisioning/active/stopped counts)

## Components

Key components (see `web/src/` for full list):
- `CreateTaskModal` / `NewAgentForm` — task creation with provider selection
- `TasksSidebar` — filterable task list
- `RunCard` — task row with status, provider badge
- `ChatPanel` / `ChatMessage` — message list + input
- `PreviewPanel` — iframe + controls
- `StatusBadge` — colored status indicator
- `Layout` — app shell

## Real-time Updates

### Dashboard

Poll `GET /api/tasks` every 5s, or upgrade to WebSocket for push updates.

### Task Detail

WebSocket to `WS /api/tasks/:id/ws`:
- Receive agent events (tokens, tool calls, completion)
- Send prompts
- Receive status changes

### Reconnection

WebSocket auto-reconnects on disconnect. Loads message history via REST on reconnect to avoid gaps.

## Styling

Tailwind CSS. Dark theme.

## Dev Setup

```bash
cd web
bun install
bun run dev    # Vite dev server on :5173, proxies /api to :3456
```

Production: `bun run build` → static files served by Hono.
