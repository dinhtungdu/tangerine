# Terminal

Interactive shell access to a task's worktree over WebSocket, using bun-pty for PTY management and xterm.js on the client.

## Architecture

```
Browser (xterm.js)
  ↕ WebSocket (JSON messages)
Hono WS route (terminal-ws.ts)
  ↕ bun-pty
Shell process (bash --login, cwd = worktree)
  ↕ disk
History + PID files (tmpdir, per-task)
```

## Session lifecycle

- One `TerminalSession` per task, keyed by `taskId`.
- Session is created on first WebSocket connect for a task. Subsequent connects reuse it.
- Session stays alive when all WebSocket clients disconnect — the shell is kept running so state (cwd, env, running commands) is preserved across browser tab closes.
- Session is destroyed only by `clearTerminalSession(taskId)`, called during task cleanup.
- If the shell exits on its own (user types `exit`), the session is removed. History is kept on disk so a reconnect can replay it, then starts a new shell.

## Scrollback persistence

- Scrollback stored in memory (`session.scrollback: string`) and persisted to disk at `os.tmpdir()/tng-<taskId8>.hist`.
- Disk writes are debounced (40ms) to avoid thrashing on high-output commands.
- Limit: 500KB (ring buffer, oldest bytes trimmed).
- On session creation, existing history is loaded from disk synchronously (one-time, at connect time).
- History survives server restarts (tmpdir persists across process restarts but not OS reboots).
- History is deleted by `clearTerminalSession` when a task is cleaned up.

## Orphan prevention

- Shell PID is written to `os.tmpdir()/tng-<taskId8>.pid` on session creation.
- Deleted on natural shell exit.
- `clearTerminalSession` reads the PID file and sends SIGKILL when no live session is found (i.e. after a server restart), preventing orphaned bash processes from outliving the task.

## WebSocket message protocol

| Direction | Type | Fields | Description |
|-----------|------|---------|-------------|
| server→client | `scrollback` | `data: string` | Replay of persisted history on connect |
| server→client | `output` | `data: string` | Live PTY output |
| server→client | `connected` | — | Session ready |
| server→client | `exit` | `code: number` | Shell exited |
| server→client | `error` | `message: string` | Setup failure |
| server→client | `ping` | — | Heartbeat |
| client→server | `input` | `data: string` | Keyboard input |
| client→server | `resize` | `cols, rows: number` | Terminal resize |
| client→server | `pong` | — | Heartbeat reply |
| client→server | `auth` | `token: string` | Auth (when enabled) |

## Connection flow

1. WebSocket opens → if auth enabled, client sends `auth` (5s timeout)
2. Server calls `getOrCreateSession(taskId, worktree)` — spawns shell if not running
3. Server sends `scrollback` with history, then marks client ready
4. Server sends any buffered output that arrived during step 3, then `connected`
5. Live `output` messages stream in real-time

## Reconnection

Client uses exponential backoff (1s → max 5s). On visibility change (returning to browser tab), reconnect fires immediately. Server replays scrollback from disk on each reconnect.

## Why no dtach

dtach was previously used for shell persistence across disconnects but added:
- Spawn overhead on first connect (dtach process + bash)
- A shadow recorder PTY to capture output while no clients were connected
- Inability to replay history natively (required a separate scrollback ring buffer)

The current design keeps the shell process alive directly via bun-pty, using the same ring buffer for both live broadcast and reconnect replay, with disk persistence for server restarts.
