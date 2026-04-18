// WebSocket route for interactive terminal access to a task's worktree.
// Uses bun-pty + dtach for persistent sessions per task.
// dtach keeps the shell alive across WebSocket disconnects — navigating away
// and back re-attaches to the same session with the shell state preserved.
// Unlike tmux, dtach doesn't capture the mouse, so copy/paste and mobile
// scroll work natively in xterm.js.
//
// Scrollback buffer: dtach doesn't replay output to new connections, so we
// keep a ring buffer per task and replay it on reconnect.
//
// Shadow recorder: a persistent server-side PTY attachment that stays connected
// to dtach even when all WebSocket clients are gone. This ensures output produced
// while disconnected (e.g. a long-running command after closing the browser tab)
// is captured and available when a client reconnects.

import { Effect } from "effect"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { spawn } from "bun-pty"
import type { IPty } from "bun-pty"
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

/** dtach socket path for a given task */
export function dtachSocketPath(taskId: string): string {
  return join(tmpdir(), `tng-${taskId.slice(0, 8)}.dtach`)
}

const SCROLLBACK_LIMIT = 100 * 1024 // 100KB per task
const scrollbackBuffers = new Map<string, string>()

// Shadow recorders: persistent PTY attachments that stay connected to dtach
// even when all WebSocket clients disconnect. One per task, keyed by taskId.
// This is the only writer to scrollbackBuffers.
const shadowRecorders = new Map<string, IPty>()
const terminalClients = new Map<string, Set<BufferedTerminalClient>>()

/** Append output to scrollback buffer, trimming if over limit */
function appendScrollback(taskId: string, data: string): void {
  const existing = scrollbackBuffers.get(taskId) ?? ""
  let combined = existing + data
  if (combined.length > SCROLLBACK_LIMIT) {
    combined = combined.slice(-SCROLLBACK_LIMIT)
  }
  scrollbackBuffers.set(taskId, combined)
}

/** Get scrollback buffer for a task */
function getScrollback(taskId: string): string {
  return scrollbackBuffers.get(taskId) ?? ""
}

const PENDING_OUTPUT_LIMIT = SCROLLBACK_LIMIT

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
    } catch {
      // Client disconnected
    }
  }
}

/** Stop the shadow recorder for a task (deletes before kill to prevent onExit loop) */
function stopShadowRecorder(taskId: string): void {
  const recorder = shadowRecorders.get(taskId)
  if (!recorder) return
  shadowRecorders.delete(taskId)
  try {
    recorder.kill()
  } catch {
    // Already dead
  }
}

/**
 * Start a persistent shadow recorder attached to dtach for continuous capture.
 * No-op if one already exists for this task.
 */
function startShadowRecorder(taskId: string, socketPath: string, worktree: string): void {
  if (shadowRecorders.has(taskId)) return

  log.debug("Starting shadow recorder", { taskId })

  const pty = spawn("dtach", [
    "-A", socketPath,
    "-z",
    "/bin/bash", "--login",
  ], {
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    cwd: worktree,
  })

  shadowRecorders.set(taskId, pty)

  pty.onData((data) => {
    appendScrollback(taskId, data)
    broadcastTerminalOutput(taskId, data)
  })

  pty.onExit(({ exitCode }) => {
    // Shell exited — clear stale scrollback only if we're still the live recorder
    if (shadowRecorders.get(taskId) === pty) {
      shadowRecorders.delete(taskId)
      scrollbackBuffers.delete(taskId)
    }
    broadcastTerminalExit(taskId, exitCode)
  })
}

/** Clear scrollback buffer and stop shadow recorder (call on task cleanup) */
export function clearScrollback(taskId: string): void {
  scrollbackBuffers.delete(taskId)
  stopShadowRecorder(taskId)
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

            const worktree = task.worktree_path
            const socketPath = dtachSocketPath(taskId)

            log.info("Terminal session starting", { taskId, worktree, socketPath })

            // Ensure the shadow recorder is running so output is captured
            // continuously regardless of how many WebSocket clients are connected.
            startShadowRecorder(taskId, socketPath, worktree)
            client = addTerminalClient(taskId, ws)

            // Replay scrollback, then enable live output. Set ready=true before
            // draining so any shadow output that arrives during replay is either:
            // (a) buffered if it lands before ready=true, then drained, or
            // (b) sent directly via broadcastTerminalOutput if it lands after.
            try {
              const scrollback = getScrollback(taskId)
              if (scrollback) {
                ws.send(JSON.stringify({ type: "scrollback", data: scrollback }))
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
          } catch {
            // Client already gone
          }
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
            } catch {
              // Client already gone
            }
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
              } catch {
                // Client already gone
              }
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

          const recorder = shadowRecorders.get(taskId)
          if (!recorder) return

          heartbeat?.markAlive()

          if (parsed.type === "input" && parsed.data) {
            recorder.write(parsed.data)
          } else if (parsed.type === "resize" && parsed.cols && parsed.rows) {
            recorder.resize(parsed.cols, parsed.rows)
          }
        },

        onClose() {
          if (authTimer) clearTimeout(authTimer)
          heartbeat?.stop()
          removeTerminalClient(taskId, client)
          log.debug("Terminal client detached (shadow recorder continues)", { taskId })
        },
      }
    })
  )

  return app
}
