// WebSocket route for interactive terminal access to a task's worktree.
// Uses bun-pty directly (no dtach) for persistent shell sessions per task.
//
// One TerminalSession per task, spawned on first connect and kept alive across
// WebSocket disconnects so cwd/env/running processes are preserved.
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
import { join } from "path"
import type { AppDeps } from "../app"
import { createWebSocketHeartbeat, type WebSocketHeartbeat } from "../ws-heartbeat"
import { isAuthEnabled, isRequestAuthenticated, isValidAuthToken } from "../../auth"
import { getTask } from "../../db/queries"
import { createLogger } from "../../logger"
import { killProcessTreeEscalated } from "../../agent/process-tree"
import { tmpdir } from "os"

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

interface TerminalProcessLaunch {
  command: string
  args: string[]
  env?: Record<string, string>
  cwd: string
}

const SCROLLBACK_LIMIT = 500 * 1024 // 500KB per task
const PERSIST_DEBOUNCE_MS = 40
const PENDING_OUTPUT_LIMIT = SCROLLBACK_LIMIT
const sessions = new Map<string, TerminalSession>()
const terminalClients = new Map<string, Set<BufferedTerminalClient>>()

export function terminalSessionKey(taskId: string): string {
  return taskId
}

function historyPath(taskId: string): string {
  return join(tmpdir(), `tng-${taskId}.hist`)
}

function pidPath(taskId: string): string {
  return join(tmpdir(), `tng-${taskId}.pid`)
}

function loadHistorySync(histPath: string): string {
  try {
    if (existsSync(histPath)) {
      return readFileSync(histPath, "utf-8")
    }
  } catch { /* non-fatal */ }
  return ""
}

function buildTerminalEnv(extraEnv: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value
  }
  return extraEnv ? { ...env, ...extraEnv } : env
}

function appendScrollback(session: TerminalSession, data: string): void {
  session.scrollback += data
  if (session.scrollback.length > SCROLLBACK_LIMIT) {
    session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT)
  }
}

function schedulePersist(session: TerminalSession): void {
  if (session.writeTimer) clearTimeout(session.writeTimer)
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

function addTerminalClient(sessionKey: string, socket: TerminalSocket): BufferedTerminalClient {
  const client: BufferedTerminalClient = { socket, ready: false, pendingOutput: "" }
  const clients = terminalClients.get(sessionKey)
  if (clients) {
    clients.add(client)
  } else {
    terminalClients.set(sessionKey, new Set([client]))
  }
  return client
}

function removeTerminalClient(sessionKey: string, client: BufferedTerminalClient | null): void {
  if (!client) return
  const clients = terminalClients.get(sessionKey)
  if (!clients) return
  clients.delete(client)
  if (clients.size === 0) {
    terminalClients.delete(sessionKey)
  }
}

function broadcastTerminalOutput(sessionKey: string, data: string): void {
  const clients = terminalClients.get(sessionKey)
  if (!clients || !data) return

  for (const client of clients) {
    const output = bufferTerminalOutput(client, data)
    if (!output) continue
    try {
      client.socket.send(JSON.stringify({ type: "output", data: output }))
    } catch {
      removeTerminalClient(sessionKey, client)
    }
  }
}

function broadcastTerminalExit(sessionKey: string, exitCode: number): void {
  const clients = terminalClients.get(sessionKey)
  if (!clients) return
  for (const client of clients) {
    try {
      client.socket.send(JSON.stringify({ type: "exit", code: exitCode }))
    } catch { /* client disconnected */ }
  }
}

function getOrCreateSession(taskId: string, launch: TerminalProcessLaunch): TerminalSession {
  const sessionKey = terminalSessionKey(taskId)
  const existing = sessions.get(sessionKey)
  if (existing) return existing

  const histPath = historyPath(taskId)
  const scrollback = loadHistorySync(histPath)

  const pty = spawn(launch.command, launch.args, {
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    cwd: launch.cwd,
    env: buildTerminalEnv(launch.env),
  })

  const session: TerminalSession = { pty, scrollback, writeTimer: null, histPath }
  sessions.set(sessionKey, session)

  // Persist PID so cleanup can kill the process after a server restart
  try {
    writeFileSync(pidPath(taskId), String(pty.pid))
  } catch { /* non-fatal */ }

  pty.onData((data) => {
    appendScrollback(session, data)
    schedulePersist(session)
    broadcastTerminalOutput(sessionKey, data)
  })

  pty.onExit(({ exitCode }) => {
    if (sessions.get(sessionKey) === session) {
      // Flush before removing so history is available for next reconnect
      flushPersistSync(session)
      sessions.delete(sessionKey)
    }
    try { unlinkSync(pidPath(taskId)) } catch { /* already gone */ }
    broadcastTerminalExit(sessionKey, exitCode)
  })

  log.debug("Terminal session started", { taskId, worktree: launch.cwd, command: launch.command })
  return session
}

/** Kill shell and delete persisted history for a task (call on task cleanup) */
export function clearTerminalSession(taskId: string): void {
  clearTerminalSessionKind(taskId)
}

function readPersistedPid(pp: string): { pid: number } | null {
  const content = readFileSync(pp, "utf-8").trim()
  const [pidLine] = content.split("\n")
  const pid = parseInt(pidLine ?? "", 10)
  return Number.isNaN(pid) ? null : { pid }
}

function isExpectedPersistedProcess(cmdline: string): boolean {
  return cmdline.includes("bash") || cmdline.includes("sh")
}

function clearTerminalSessionKind(taskId: string): void {
  const sessionKey = terminalSessionKey(taskId)
  const session = sessions.get(sessionKey)
  sessions.delete(sessionKey)

  if (session) {
    if (session.writeTimer) {
      clearTimeout(session.writeTimer)
      session.writeTimer = null
    }
    const pid = session.pty.pid
    try { session.pty.kill() } catch { /* already dead */ }
    killProcessTreeEscalated(pid)
    try { unlinkSync(session.histPath) } catch { /* no file */ }
    try { unlinkSync(pidPath(taskId)) } catch { /* no file */ }
  } else {
    // Server may have restarted — recover terminal PID from disk and kill it.
    // Validate via /proc/<pid>/cmdline before killing to avoid hitting a
    // reused PID that belongs to an unrelated process.
    const pp = pidPath(taskId)
    try {
      const record = readPersistedPid(pp)
      if (record) {
        const { pid } = record
        process.kill(pid, 0) // throws ESRCH if process is gone
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8")
        if (isExpectedPersistedProcess(cmdline)) {
          killProcessTreeEscalated(pid)
        }
      }
    } catch { /* process gone, /proc unavailable, or not a shell — skip */ }
    try { unlinkSync(pp) } catch { /* no file */ }
    try { unlinkSync(historyPath(taskId)) } catch { /* no file */ }
  }
}

export function terminalWsRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono()

  const socketRoute = () =>
    upgradeWebSocket((c) => {
      const taskId = c.req.param("id")!
      const sessionKey = terminalSessionKey(taskId)
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
            if (!task?.worktree_path) {
              // Terminal tasks (done/failed/cancelled) have their worktree cleaned up
              // permanently — tell the client to stop retrying. Non-terminal tasks
              // (created/provisioning/running) may still be acquiring their worktree,
              // so close silently and let the client retry on its normal backoff.
              const isTerminal = task?.status === "done" || task?.status === "failed" || task?.status === "cancelled"
              if (isTerminal) {
                throw new Error("Task has no worktree")
              } else {
                ws.close(1011, "Worktree not yet available")
                return
              }
            }

            const launch: TerminalProcessLaunch = { command: "/bin/bash", args: ["--login"], cwd: task.worktree_path }

            const session = getOrCreateSession(taskId, launch)
            client = addTerminalClient(sessionKey, ws)

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
              removeTerminalClient(sessionKey, client)
            }
          }),
        ).catch((err) => {
          // "no worktree" is an expected condition (e.g. completed tasks) — log
          // at debug so it doesn't flood the error log on client reconnect loops.
          const msg = String(err)
          if (msg.includes("no worktree")) {
            log.debug("Terminal unavailable: task has no worktree", { taskId })
          } else {
            log.error("Terminal session failed", { taskId, error: msg })
          }
          try {
            ws.send(JSON.stringify({ type: "error", message: msg }))
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

          const session = sessions.get(sessionKey)
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
          removeTerminalClient(sessionKey, client)
          log.debug("Terminal client detached (session continues)", { taskId })
        },
      }
    })

  app.get("/:id/terminal", socketRoute())

  return app
}
