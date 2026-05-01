# TUI Toggle

Switch between the structured chat pane and the agent's native TUI (e.g. Claude Code) within the same task, embedded in the dashboard via xterm.js.

## Motivation

Tangerine's chat pane normalizes agent messages into a structured UI. But agents like Claude Code have rich native TUIs with slash commands, tool approval dialogs, thinking blocks, and shell escapes that the chat pane can't reproduce. Users need to drop into the native TUI without leaving the dashboard, then switch back to chat view — all within the same agent session.

## Design

Exclusive mode toggle. A task is in **chat mode** or **TUI mode** at any time, never both.

```
Task Header: [ Chat | TUI ] toggle button

Chat mode (default):
  ┌──────────────────────┐
  │ Chat pane            │  ← structured messages from session_logs
  │ (existing behavior)  │
  └──────────────────────┘

TUI mode:
  ┌──────────────────────┐
  │ xterm.js terminal    │  ← native agent TUI via PTY
  │ (full agent UI)      │
  └──────────────────────┘
```

The command terminal pane (shell in worktree) is separate and unaffected. TUI toggle replaces only the chat pane area.

## Mode switch lifecycle

### Chat → TUI

1. Server closes the ACP connection to the running agent process
2. Server spawns the agent's native TUI command with resume flag (e.g. `claude --resume <session-id>`) as a PTY in the task's worktree
3. PTY connects to browser via the same WebSocket + xterm.js infrastructure used by the command terminal
4. Task state records `interactionMode: "tui"`
5. Dashboard swaps chat pane for terminal emulator

### TUI → Chat

1. User clicks toggle (or agent TUI process exits naturally)
2. Server kills the TUI PTY process (sends SIGHUP, then SIGKILL after timeout)
3. Server re-establishes the ACP connection using `session/resume` (falling back to `session/load`)
4. Server inserts a placeholder message in `session_logs`: `[continued in TUI]` with role `system`
5. Task state records `interactionMode: "chat"`
6. Dashboard swaps terminal emulator for chat pane

### Edge cases

- **TUI process exits on its own** (user types `/exit`, agent crashes): server detects PTY exit, auto-switches back to chat mode, reconnects ACP
- **Task cancelled/stopped while in TUI mode**: kill PTY, normal task cleanup, no ACP reconnect needed
- **Server restart while in TUI mode**: TUI PTY is lost (same as command terminal behavior). On reconnect, fall back to chat mode and resume ACP
- **Browser disconnect in TUI mode**: PTY stays alive (same as command terminal). Browser reconnects and replays scrollback

## Implementation tiers

### Tier 0 — Toggle with placeholder (MVP)

- Toggle button in task header
- ACP disconnect → PTY spawn → ACP reconnect lifecycle
- `[continued in TUI]` placeholder in `session_logs` when switching back
- Chat pane shows placeholder as a system message in the timeline
- No attempt to capture or parse TUI content

### Tier 1 — Scrollback persistence

- TUI PTY scrollback stored to disk (reuse existing terminal scrollback infra: ring buffer, debounced writes, tmpdir)
- Scrollback viewable as raw terminal replay when switching back or on reconnect
- Optional: "View TUI session" button on the placeholder message opens a read-only terminal replay

### Tier 2 — Backfill from agent logs (future)

- After switching back to chat, read the agent's local session log files
- Parse into normalized messages and insert into `session_logs`
- Provider-specific adapter per agent (start with Claude Code)
- Best-effort: if parsing fails, placeholder remains
- Agent log files are structured JSON — much simpler than parsing raw TUI terminal output

## Server changes

### Task state

Add `interactionMode` field to in-memory task state (not persisted to DB — defaults to `"chat"` on server restart):

```typescript
type InteractionMode = "chat" | "tui"
```

### New API endpoints

```
POST /api/tasks/:id/tui/start    → disconnect ACP, spawn TUI PTY
POST /api/tasks/:id/tui/stop     → kill TUI PTY, reconnect ACP
GET  /api/tasks/:id/tui/status   → { mode: "chat" | "tui" }
WS   /api/tasks/:id/tui/terminal → xterm.js websocket for TUI PTY
```

The TUI terminal WebSocket uses the same protocol as the command terminal (see `specs/terminal.md`).

### TUI PTY management

Reuse `terminal-ws.ts` infrastructure with a separate session namespace (e.g. `tui:<taskId>` vs `<taskId>` for command terminal). Same scrollback persistence, same orphan cleanup, same reconnection behavior.

### Agent command resolution

Each agent provider needs a TUI launch command. Extend agent config:

```typescript
interface AgentConfig {
  // ... existing fields
  tuiCommand?: string      // e.g. "claude"
  tuiResumeFlag?: string   // e.g. "--resume"
}
```

Launch: `<tuiCommand> <tuiResumeFlag> <sessionId>` in the task's worktree with the task's env.

If `tuiCommand` is not configured for the agent, the TUI toggle is hidden for that task.

## Web changes

### Task header

Add toggle button (only visible when agent supports TUI):

```
[💬 Chat] [▶ TUI]
```

Active mode highlighted. Clicking the inactive mode triggers the switch via API.

### Chat pane area

- Chat mode: render existing `ChatPane` component
- TUI mode: render `TerminalPane` with `wsUrl="/api/tasks/${taskId}/tui/terminal"`

The existing `TerminalPane` component works as-is — it accepts a `wsUrl` prop and handles connection, scrollback, input, and resize.

### Placeholder message

`[continued in TUI]` renders as a distinct system message in the chat timeline — muted style, centered, with timestamp. Similar treatment to existing system messages.

## What this does NOT change

- Command terminal pane (shell in worktree) — unchanged, always available
- `session_logs` as source of truth for chat history — unchanged
- ACP protocol — no extensions needed
- Agent process lifecycle — ACP manages the agent; TUI is a separate process sharing the session

## Provider support matrix

| Agent | TUI command | Resume flag | Supported |
|-------|------------|-------------|-----------|
| Claude Code | `claude` | `--resume` | Yes |
| Codex | `codex` | TBD | TBD |
| OpenCode | `opencode` | TBD | TBD |
| Custom | configurable | configurable | If configured |

## Spike findings

1. **`claude --resume` works after ACP disconnect.** ACP (`claude-code-acp`) and native TUI (`claude`) share the same session store at `~/.claude/projects/<dir>/<session-id>.jsonl`. Session IDs are UUIDs. After ACP `session/close` + process kill, `claude --resume <session-id>` picks up the full conversation history. Confirmed by inspecting session files.
2. **Exclusive mode is required.** The session JSONL is append-only and not designed for concurrent writers. ACP and TUI must not run simultaneously on the same session.
3. **TUI environment**: The native TUI inherits the worktree's environment. No special `CLAUDE_CODE_*` vars needed — `claude --resume` discovers project context from `cwd`.
