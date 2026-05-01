// TUI mode lifecycle: disconnect ACP, spawn native agent TUI as PTY, reconnect ACP.

import { Effect } from "effect"
import { spawn } from "bun-pty"
import type { IPty } from "bun-pty"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { createLogger } from "../logger"
import type { AgentHandle } from "../agent/provider"
import { getAgentHandleMeta } from "../agent/provider"
import { killProcessTreeEscalated } from "../agent/process-tree"
import { getTaskState } from "./task-state"
import { emitTaskEvent } from "./events"
import type { TaskRow } from "../db/types"

const log = createLogger("tui")

const TUI_SCROLLBACK_LIMIT = 500 * 1024
const TUI_PERSIST_DEBOUNCE_MS = 40

interface TuiSession {
  pty: IPty
  scrollback: string
  writeTimer: ReturnType<typeof setTimeout> | null
  histPath: string
  sessionId: string
}

type TuiSocket = { send(data: string): void; close(code?: number, reason?: string): void }

export interface BufferedTuiClient {
  socket: TuiSocket
  ready: boolean
  pendingOutput: string
}

const tuiSessions = new Map<string, TuiSession>()
const tuiClients = new Map<string, Set<BufferedTuiClient>>()

function tuiHistPath(taskId: string): string {
  return join(tmpdir(), `tng-tui-${taskId}.hist`)
}

function tuiPidPath(taskId: string): string {
  return join(tmpdir(), `tng-tui-${taskId}.pid`)
}

function loadHistorySync(histPath: string): string {
  try {
    if (existsSync(histPath)) return readFileSync(histPath, "utf-8")
  } catch { /* non-fatal */ }
  return ""
}

function appendScrollback(session: TuiSession, data: string): void {
  session.scrollback += data
  if (session.scrollback.length > TUI_SCROLLBACK_LIMIT) {
    session.scrollback = session.scrollback.slice(-TUI_SCROLLBACK_LIMIT)
  }
}

function schedulePersist(session: TuiSession): void {
  if (session.writeTimer) clearTimeout(session.writeTimer)
  session.writeTimer = setTimeout(() => {
    session.writeTimer = null
    Bun.write(session.histPath, session.scrollback).catch(() => {})
  }, TUI_PERSIST_DEBOUNCE_MS)
}

function flushPersistSync(session: TuiSession): void {
  if (session.writeTimer) {
    clearTimeout(session.writeTimer)
    session.writeTimer = null
  }
  try { writeFileSync(session.histPath, session.scrollback) } catch { /* non-fatal */ }
}

function broadcastTuiOutput(taskId: string, data: string): void {
  const clients = tuiClients.get(taskId)
  if (!clients || !data) return
  for (const client of clients) {
    const output = bufferTuiOutput(client, data)
    if (!output) continue
    try {
      client.socket.send(JSON.stringify({ type: "output", data: output }))
    } catch {
      removeTuiClient(taskId, client)
    }
  }
}

function broadcastTuiExit(taskId: string, exitCode: number): void {
  const clients = tuiClients.get(taskId)
  if (!clients) return
  for (const client of clients) {
    try {
      client.socket.send(JSON.stringify({ type: "exit", code: exitCode }))
    } catch { /* disconnected */ }
  }
}

export function bufferTuiOutput(client: BufferedTuiClient, data: string): string | null {
  if (!data) return null
  if (!client.ready) {
    client.pendingOutput += data
    if (client.pendingOutput.length > TUI_SCROLLBACK_LIMIT) {
      client.pendingOutput = client.pendingOutput.slice(-TUI_SCROLLBACK_LIMIT)
    }
    return null
  }
  return data
}

export function drainPendingTuiOutput(client: BufferedTuiClient): string {
  const pending = client.pendingOutput
  client.pendingOutput = ""
  return pending
}

export function addTuiClient(taskId: string, socket: TuiSocket): BufferedTuiClient {
  const client: BufferedTuiClient = { socket, ready: false, pendingOutput: "" }
  const clients = tuiClients.get(taskId)
  if (clients) {
    clients.add(client)
  } else {
    tuiClients.set(taskId, new Set([client]))
  }
  return client
}

export function removeTuiClient(taskId: string, client: BufferedTuiClient | null): void {
  if (!client) return
  const clients = tuiClients.get(taskId)
  if (!clients) return
  clients.delete(client)
  if (clients.size === 0) tuiClients.delete(taskId)
}

export function getTuiSession(taskId: string): TuiSession | undefined {
  return tuiSessions.get(taskId)
}

export function isTuiActive(taskId: string): boolean {
  return tuiSessions.has(taskId)
}

export interface TuiStartDeps {
  getAgentHandle(taskId: string): AgentHandle | null
  removeAgentHandle(taskId: string): void
  getTask(taskId: string): Effect.Effect<TaskRow | null, Error>
  logActivity(taskId: string, type: "lifecycle" | "system", event: string, content: string, metadata?: Record<string, unknown>): Effect.Effect<unknown, Error>
  onTuiExit?(taskId: string): void
}

export function startTuiMode(
  taskId: string,
  tuiCommand: string,
  deps: TuiStartDeps,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const task = yield* deps.getTask(taskId)
    if (!task) return yield* Effect.fail(new Error("Task not found"))
    if (!task.worktree_path) return yield* Effect.fail(new Error("Task has no worktree"))
    if (tuiSessions.has(taskId)) return yield* Effect.fail(new Error("TUI already active"))

    const handle = deps.getAgentHandle(taskId)
    if (!handle) return yield* Effect.fail(new Error("No agent handle — cannot get session ID"))

    const meta = getAgentHandleMeta(handle)
    const sessionId = meta?.sessionId
    if (!sessionId) return yield* Effect.fail(new Error("No session ID available"))

    yield* handle.shutdown()
    deps.removeAgentHandle(taskId)

    const histPath = tuiHistPath(taskId)
    const scrollback = loadHistorySync(histPath)

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value
    }

    const pty = spawn(tuiCommand, ["--resume", sessionId], {
      cols: 80,
      rows: 24,
      name: "xterm-256color",
      cwd: task.worktree_path,
      env,
    })

    const session: TuiSession = { pty, scrollback, writeTimer: null, histPath, sessionId }
    tuiSessions.set(taskId, session)

    try { writeFileSync(tuiPidPath(taskId), String(pty.pid)) } catch { /* non-fatal */ }

    pty.onData((data) => {
      appendScrollback(session, data)
      schedulePersist(session)
      broadcastTuiOutput(taskId, data)
    })

    pty.onExit(({ exitCode }) => {
      if (tuiSessions.get(taskId) === session) {
        flushPersistSync(session)
        tuiSessions.delete(taskId)
      }
      try { unlinkSync(tuiPidPath(taskId)) } catch { /* already gone */ }
      broadcastTuiExit(taskId, exitCode)
      deps.onTuiExit?.(taskId)
    })

    const state = getTaskState(taskId)
    state.tuiMode = true

    emitTaskEvent(taskId, { event: "tui_mode", active: true })

    yield* deps.logActivity(taskId, "lifecycle", "tui.started", "Switched to TUI mode").pipe(
      Effect.catchAll(() => Effect.succeed(undefined))
    )

    log.info("TUI mode started", { taskId, sessionId, pid: pty.pid })
  })
}

export function stopTuiMode(
  taskId: string,
): Effect.Effect<{ sessionId: string }, Error> {
  return Effect.try({
    try: () => {
      const session = tuiSessions.get(taskId)
      if (!session) throw new Error("TUI not active")

      const { sessionId } = session

      flushPersistSync(session)
      tuiSessions.delete(taskId)

      try { session.pty.kill() } catch { /* already dead */ }
      killProcessTreeEscalated(session.pty.pid)

      try { unlinkSync(tuiPidPath(taskId)) } catch { /* no file */ }

      const state = getTaskState(taskId)
      state.tuiMode = false

      emitTaskEvent(taskId, { event: "tui_mode", active: false })

      log.info("TUI mode stopped", { taskId, sessionId })

      return { sessionId }
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  })
}

export function clearTuiSession(taskId: string): void {
  const session = tuiSessions.get(taskId)
  tuiSessions.delete(taskId)

  if (session) {
    if (session.writeTimer) clearTimeout(session.writeTimer)
    try { session.pty.kill() } catch { /* already dead */ }
    try { unlinkSync(session.histPath) } catch { /* no file */ }
    try { unlinkSync(tuiPidPath(taskId)) } catch { /* no file */ }
  } else {
    const pp = tuiPidPath(taskId)
    try {
      const content = readFileSync(pp, "utf-8").trim()
      const pid = parseInt(content, 10)
      if (!Number.isNaN(pid)) {
        process.kill(pid, 0)
        process.kill(pid, "SIGKILL")
      }
    } catch { /* process gone */ }
    try { unlinkSync(pp) } catch { /* no file */ }
    try { unlinkSync(tuiHistPath(taskId)) } catch { /* no file */ }
  }

  const state = getTaskState(taskId)
  state.tuiMode = false
}
