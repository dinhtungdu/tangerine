// WebSocket route for interactive terminal access to a task's worktree.
// Uses bun-pty directly (no dtach) for persistent shell sessions per task.
//
// One TerminalSession per task/kind: shell or agent TUI spawned on first
// connect, kept alive across WebSocket disconnects so cwd/env/running processes are preserved.
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
import { basename, join } from "path"
import { DEFAULT_AGENT_ID, type AgentConfig } from "@tangerine/shared"
import { resolveAcpCommand } from "../../agent/acp-provider"
import type { AppDeps } from "../app"
import { createWebSocketHeartbeat, type WebSocketHeartbeat } from "../ws-heartbeat"
import { isAuthEnabled, isRequestAuthenticated, isValidAuthToken } from "../../auth"
import { getTask } from "../../db/queries"
import { createLogger } from "../../logger"
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

type TerminalKind = "shell" | "agent"

interface TerminalLaunch {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface TerminalProcessLaunch extends TerminalLaunch {
  cwd: string
}

const SCROLLBACK_LIMIT = 500 * 1024 // 500KB per task
const PERSIST_DEBOUNCE_MS = 40
const PENDING_OUTPUT_LIMIT = SCROLLBACK_LIMIT
const TERMINAL_KINDS: TerminalKind[] = ["shell", "agent"]

const sessions = new Map<string, TerminalSession>()
const terminalClients = new Map<string, Set<BufferedTerminalClient>>()

export function terminalSessionKey(taskId: string, kind: TerminalKind): string {
  return `${kind}:${taskId}`
}

function historyPath(taskId: string, kind: TerminalKind): string {
  return join(tmpdir(), kind === "shell" ? `tng-${taskId}.hist` : `tng-${taskId}.agent.hist`)
}

function pidPath(taskId: string, kind: TerminalKind): string {
  return join(tmpdir(), kind === "shell" ? `tng-${taskId}.pid` : `tng-${taskId}.agent.pid`)
}

function loadHistorySync(histPath: string): string {
  try {
    if (existsSync(histPath)) {
      return readFileSync(histPath, "utf-8")
    }
  } catch { /* non-fatal */ }
  return ""
}

function replaceLaunchPlaceholders(value: string, sessionId: string, worktree: string): string {
  return value.replaceAll("{sessionId}", sessionId).replaceAll("{worktree}", worktree)
}

function replaceLaunchEnv(env: Record<string, string> | undefined, sessionId: string, worktree: string): Record<string, string> | undefined {
  if (!env) return undefined
  const entries = Object.entries(env).map(([key, value]) => [key, replaceLaunchPlaceholders(value, sessionId, worktree)] as const)
  return Object.fromEntries(entries)
}

function mergeLaunchEnv(baseEnv: Record<string, string> | undefined, tuiEnv: Record<string, string> | undefined, sessionId: string, worktree: string): Record<string, string> | undefined {
  const merged = { ...(baseEnv ?? {}), ...(tuiEnv ?? {}) }
  return Object.keys(merged).length > 0 ? replaceLaunchEnv(merged, sessionId, worktree) : undefined
}

function commandName(command: string): string {
  return basename(command).toLowerCase()
}

function commandTokens(agent: AgentConfig): string[] {
  return [agent.command, ...(agent.args ?? [])].map((token) => token.toLowerCase())
}

function tokenIncludes(agent: AgentConfig, value: string): boolean {
  return commandTokens(agent).some((token) => token.includes(value))
}

function buildTerminalEnv(extraEnv: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value
  }
  return extraEnv ? { ...env, ...extraEnv } : env
}

export function resolveAgentTuiLaunch(agent: AgentConfig, sessionId: string, worktree: string): TerminalLaunch | null {
  if (agent.tui) {
    return {
      command: replaceLaunchPlaceholders(agent.tui.command, sessionId, worktree),
      args: (agent.tui.args ?? []).map((arg) => replaceLaunchPlaceholders(arg, sessionId, worktree)),
      env: mergeLaunchEnv(agent.env, agent.tui.env, sessionId, worktree),
    }
  }

  const name = commandName(agent.command)
  const args = agent.args ?? []
  const env = mergeLaunchEnv(agent.env, undefined, sessionId, worktree)
  if (name === "codex" || name === "codex-acp" || tokenIncludes(agent, "@zed-industries/codex-acp")) {
    return { command: "codex", args: ["resume", sessionId], env }
  }
  if (name === "claude" || name === "claude-agent-acp" || tokenIncludes(agent, "claude-agent-acp")) {
    return { command: "claude", args: ["--resume", sessionId], env }
  }
  if (name === "opencode" || tokenIncludes(agent, "opencode-ai")) {
    return { command: "opencode", args: ["--session", sessionId], env }
  }
  if (name === "pi" || name === "pi-acp" || tokenIncludes(agent, "pi-acp")) {
    return { command: "pi", args: ["--session", sessionId], env }
  }
  if (name === "hermes") {
    const passthroughArgs = args.filter((arg) => arg !== "acp")
    return { command: "hermes", args: ["--resume", sessionId, "--tui", ...passthroughArgs], env }
  }

  return null
}

export function resolveAgentTuiLaunchForProvider(agents: AgentConfig[], provider: string, sessionId: string, worktree: string): TerminalLaunch | null {
  const configured = agents.find((entry) => entry.id === provider)
  const agent = configured ?? (provider === DEFAULT_AGENT_ID ? defaultAcpAgentConfig() : null)
  return agent ? resolveAgentTuiLaunch(agent, sessionId, worktree) : null
}

function defaultAcpAgentConfig(): AgentConfig {
  const command = resolveAcpCommand(process.env)
  return {
    id: DEFAULT_AGENT_ID,
    name: "ACP",
    command: command.checkCommand,
    args: command.shellCommand === command.checkCommand ? undefined : [command.shellCommand],
  }
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

function getOrCreateSession(taskId: string, kind: TerminalKind, launch: TerminalProcessLaunch): TerminalSession {
  const sessionKey = terminalSessionKey(taskId, kind)
  const existing = sessions.get(sessionKey)
  if (existing) return existing

  const histPath = historyPath(taskId, kind)
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
    const pidRecord = kind === "agent" ? `${pty.pid}\n${launch.command}\n` : String(pty.pid)
    writeFileSync(pidPath(taskId, kind), pidRecord)
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
    try { unlinkSync(pidPath(taskId, kind)) } catch { /* already gone */ }
    broadcastTerminalExit(sessionKey, exitCode)
  })

  log.debug("Terminal session started", { taskId, kind, worktree: launch.cwd, command: launch.command })
  return session
}

/** Kill shell and delete persisted history for a task (call on task cleanup) */
export function clearTerminalSession(taskId: string): void {
  for (const kind of TERMINAL_KINDS) clearTerminalSessionKind(taskId, kind)
}

function readPersistedPid(pp: string): { pid: number; command?: string } | null {
  const content = readFileSync(pp, "utf-8").trim()
  const [pidLine, command] = content.split("\n")
  const pid = parseInt(pidLine ?? "", 10)
  return Number.isNaN(pid) ? null : { pid, command }
}

function isExpectedPersistedProcess(kind: TerminalKind, cmdline: string, command?: string): boolean {
  if (kind === "shell") return cmdline.includes("bash") || cmdline.includes("sh")
  if (!command) return false
  return cmdline.includes(basename(command))
}

function clearTerminalSessionKind(taskId: string, kind: TerminalKind): void {
  const sessionKey = terminalSessionKey(taskId, kind)
  const session = sessions.get(sessionKey)
  sessions.delete(sessionKey)

  if (session) {
    if (session.writeTimer) {
      clearTimeout(session.writeTimer)
      session.writeTimer = null
    }
    try { session.pty.kill() } catch { /* already dead */ }
    try { unlinkSync(session.histPath) } catch { /* no file */ }
    try { unlinkSync(pidPath(taskId, kind)) } catch { /* no file */ }
  } else {
    // Server may have restarted — recover terminal PID from disk and kill it.
    // Validate via /proc/<pid>/cmdline before killing to avoid hitting a
    // reused PID that belongs to an unrelated process.
    const pp = pidPath(taskId, kind)
    try {
      const record = readPersistedPid(pp)
      if (record) {
        const { pid, command } = record
        process.kill(pid, 0) // throws ESRCH if process is gone
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8")
        if (isExpectedPersistedProcess(kind, cmdline, command)) {
          process.kill(pid, "SIGKILL")
        }
      }
    } catch { /* process gone, /proc unavailable, or not a shell — skip */ }
    try { unlinkSync(pp) } catch { /* no file */ }
    try { unlinkSync(historyPath(taskId, kind)) } catch { /* no file */ }
  }
}

export function terminalWsRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono()

  const socketRoute = (kind: TerminalKind) =>
    upgradeWebSocket((c) => {
      const taskId = c.req.param("id")!
      const sessionKey = terminalSessionKey(taskId, kind)
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

            const launch: TerminalProcessLaunch = kind === "shell"
              ? { command: "/bin/bash", args: ["--login"], cwd: task.worktree_path }
              : (() => {
                if (!task.agent_session_id) throw new Error("Agent TUI not available: missing session id")
                const agentLaunch = resolveAgentTuiLaunchForProvider(deps.config.config.agents, task.provider, task.agent_session_id, task.worktree_path)
                if (!agentLaunch) throw new Error(`Agent TUI not available: no TUI command configured for ${task.provider}`)
                return { ...agentLaunch, cwd: task.worktree_path }
              })()

            const session = getOrCreateSession(taskId, kind, launch)
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
            log.debug("Terminal unavailable: task has no worktree", { taskId, kind })
          } else {
            log.error("Terminal session failed", { taskId, kind, error: msg })
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
          log.debug("Terminal client detached (session continues)", { taskId, kind })
        },
      }
    })

  app.get("/:id/terminal", socketRoute("shell"))
  app.get("/:id/agent-terminal", socketRoute("agent"))

  return app
}
