// WebSocket route for interactive terminal access to a task's worktree.
// Uses bun-pty directly (no dtach) for persistent shell sessions per task.
//
// One TerminalSession per task: shell spawned on first connect, kept alive
// across WebSocket disconnects so cwd/env/running processes are preserved.
// Session is destroyed only when the task is cleaned up (clearTerminalSession).
//
// Scrollback is stored in memory and persisted to disk (debounced 40ms writes).
// History survives server restarts. Client replays scrollback on every reconnect.

import { Effect } from "effect"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { spawn } from "bun-pty"
import type { IPty } from "bun-pty"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import type { AppDeps } from "../app"
import { createWebSocketHeartbeat, type WebSocketHeartbeat } from "../ws-heartbeat"
import { isAuthEnabled, isRequestAuthenticated, isValidAuthToken } from "../../auth"
import { getTask } from "../../db/queries"
import { createLogger } from "../../logger"
import { tmpdir } from "os"
import { join } from "path"

const log = createLogger("terminal-ws")

type TerminalSocket = { send(data: string): void; close(code?: number, reason?: string): void }

interface BufferedTerminalClient {
  socket: TerminalSocket
  ready: boolean
  pendingOutput: string
}

interface TerminalSession {
  pty: IPty
  scrollback: string
  writeTimer: ReturnType<typeof setTimeout> | null
  histPath: string
}

const SCROLLBACK_LIMIT = 500 * 1024 // 500KB per task
const PERSIST_DEBOUNCE_MS = 40
const PENDING_OUTPUT_LIMIT = SCROLLBACK_LIMIT

const sessions = new Map<string, TerminalSession>()
const terminalClients = new Map<string, Set<BufferedTerminalClient>>()

function historyPath(taskId: string): string {
  return join(tmpdir(), `tng-${taskId.slice(0, 8)}.hist`)
}

function loadHistorySync(histPath: string): string {
  try {
    if (existsSync(histPath)) {
      return readFileSync(histPath, "utf-8")
    }
  } catch { /* non-fatal */ }
  return ""
}

function appendScrollback(session: TerminalSession, data: string): void {
  session.scrollback += data
  if (session.scrollback.length > SCROLLBACK_LIMIT) {
    session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT)
  }
}

function schedulePersist(session: TerminalSession): void {
  if (session.writeTimer) return
  session.writeTimer = setTimeout(() => {
    session.writeTimer = null
    Bun.write(session.histPath, session.scrollback).catch(() => {})
  }, PERSIST_DEBOUNCE_MS)
}

function flushPersistSync(session: TerminalSession): void {
  if (session.writeTimer) {
    clearTimeout(session.writeTimer)
    session.writeTimer = null
  }
  try {
    writeFileSync(session.histPath, session.scrollback)
  } catch { /* non-fatal */ }
}

export function bufferTerminalOutput(client: BufferedTerminalClient, data: string): string | null {
  if (!data) return null
  if (!client.ready) {
    client.pendingOutput += data
    if (client.pendingOutput.length > PENDING_OUTPUT_LIMIT) {
      client.pendingOutput = client.pendingOutput.slice(-PENDING_OUTPUT_LIMIT)
    }
    return null
  }
  return data
}

export function drainPendingTerminalOutput(client: BufferedTerminalClient): string {
  const pendingOutput = client.pendingOutput
  client.pendingOutput = ""
  return pendingOutput
}

function addTerminalClient(taskId: string, socket: TerminalSocket): BufferedTerminalClient {
  const client: BufferedTerminalClient = { socket, ready: false, pendingOutput: "" }
  const clients = terminalClients.get(taskId)
  if (clients) {
    clients.add(client)
  } else {
    terminalClients.set(taskId, new Set([client]))
  }
  return client
}

function removeTerminalClient(taskId: string, client: BufferedTerminalClient | null): void {
  if (!client) return
  const clients = terminalClients.get(taskId)
  if (!clients) return
  clients.delete(client)
  if (clients.size === 0) {
    terminalClients.delete(taskId)
  }
}

function broadcastTerminalOutput(taskId: string, data: string): void {
  const clients = terminalClients.get(taskId)
  if (!clients || !data) return

  for (const client of clients) {
    const output = bufferTerminalOutput(client, data)
    if (!output) continue
    try {
      client.socket.send(JSON.stringify({ type: "output", data: output }))
    } catch {
      removeTerminalClient(taskId, client)
    }
  }
}

function broadcastTerminalExit(taskId: string, exitCode: number): void {
  const clients = terminalClients.get(taskId)
  if (!clients) return
  for (const client of clients) {
    try {
      client.socket.send(JSON.stringify({ type: "exit", code: exitCode }))
    } catch { /* client disconnected */ }
  }
}

function getOrCreateSession(taskId: string, worktree: string): TerminalSession {
  const existing = sessions.get(taskId)
  if (existing) return existing

  const histPath = historyPath(taskId)
  const scrollback = loadHistorySync(histPath)

  const pty = spawn("/bin/bash", ["--login"], {
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    cwd: worktree,
  })

  const session: TerminalSession = { pty, scrollback, writeTimer: null, histPath }
  sessions.set(taskId, session)

  pty.onData((data) => {
    appendScrollback(session, data)
    schedulePersist(session)
    broadcastTerminalOutput(taskId, data)
  })

  pty.onExit(({ exitCode }) => {
    if (sessions.get(taskId) === session) {
      // Flush before removing so history is available for next reconnect
      flushPersistSync(session)
      sessions.delete(taskId)
    }
    broadcastTerminalExit(taskId, exitCode)
  })

  log.debug("Terminal session started", { taskId, worktree })
  return session
}

/** Kill shell and delete persisted history for a task (call on task cleanup) */
export function clearTerminalSession(taskId: string): void {
  const session = sessions.get(taskId)
  sessions.delete(taskId)

  if (session) {
    if (session.writeTimer) {
      clearTimeout(session.writeTimer)
      session.writeTimer = null
    }
    try { session.pty.kill() } catch { /* already dead */ }
    try { unlinkSync(session.histPath) } catch { /* no file */ }
  } else {
    // Server may have restarted — still clean up any orphaned history file
    try { unlinkSync(historyPath(taskId)) } catch { /* no file */ }
  }
}

export function terminalWsRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono()

  app.get(
    "/:id/terminal",
    upgradeWebSocket((c) => {
      const taskId = c.req.param("id")!
      const authEnabled = isAuthEnabled(deps.config)
      const requestAuthenticated = isRequestAuthenticated(c, deps.config)
      let client: BufferedTerminalClient | null = null
      let heartbeat: WebSocketHeartbeat | null = null
      let authenticated = !authEnabled || requestAuthenticated
      let authTimer: ReturnType<typeof setTimeout> | null = null
      let started = false

      const startTerminal = (ws: TerminalSocket) => {
        if (started) return
        started = true
        heartbeat = createWebSocketHeartbeat(ws)
        heartbeat.start()

        Effect.runPromise(
          Effect.gen(function* () {
            const task = yield* getTask(deps.db, taskId)
            if (!task?.worktree_path) throw new Error("Task has no worktree")

            const session = getOrCreateSession(taskId, task.worktree_path)
            client = addTerminalClient(taskId, ws)

            // Replay scrollback, then enable live output. Set ready=true before
            // draining so any output that arrives during replay is either:
            // (a) buffered if it lands before ready=true, then drained, or
            // (b) sent directly via broadcastTerminalOutput if it lands after.
            try {
              if (session.scrollback) {
                ws.send(JSON.stringify({ type: "scrollback", data: session.scrollback }))
              }
              client.ready = true
              const pendingOutput = drainPendingTerminalOutput(client)
              if (pendingOutput) {
                ws.send(JSON.stringify({ type: "output", data: pendingOutput }))
              }
              ws.send(JSON.stringify({ type: "connected" }))
            } catch {
              removeTerminalClient(taskId, client)
            }
          }),
        ).catch((err) => {
          log.error("Terminal session failed", { taskId, error: String(err) })
          try {
            ws.send(JSON.stringify({ type: "error", message: String(err) }))
            ws.close(1011, "Terminal setup failed")
          } catch { /* client already gone */ }
        })
      }

      return {
        onOpen(_event, ws) {
          if (authenticated) {
            startTerminal(ws)
            return
          }
          authTimer = setTimeout(() => {
            try {
              ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }))
              ws.close(1008, "Unauthorized")
            } catch { /* client already gone */ }
          }, 5000)
        },

        onMessage(event, ws) {
          let parsed: { type: string; data?: string; cols?: number; rows?: number; token?: string }
          try {
            const raw = typeof event.data === "string" ? event.data : event.data.toString()
            parsed = JSON.parse(raw)
          } catch {
            return
          }

          if (parsed.type === "auth") {
            if (!authEnabled || authenticated) return
            if (!isValidAuthToken(deps.config.credentials.tangerineAuthToken!, parsed.token)) {
              try {
                ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }))
                ws.close(1008, "Unauthorized")
              } catch { /* client already gone */ }
              return
            }
            authenticated = true
            if (authTimer) {
              clearTimeout(authTimer)
              authTimer = null
            }
            startTerminal(ws)
            return
          }

          if (parsed.type === "pong") {
            heartbeat?.markAlive()
            return
          }

          if (!authenticated) return

          const session = sessions.get(taskId)
          if (!session) return

          heartbeat?.markAlive()

          if (parsed.type === "input" && parsed.data) {
            session.pty.write(parsed.data)
          } else if (parsed.type === "resize" && parsed.cols && parsed.rows) {
            session.pty.resize(parsed.cols, parsed.rows)
          }
        },

        onClose() {
          if (authTimer) clearTimeout(authTimer)
          heartbeat?.stop()
          removeTerminalClient(taskId, client)
          log.debug("Terminal client detached (session continues)", { taskId })
        },
      }
    })
  )

  return app
}
