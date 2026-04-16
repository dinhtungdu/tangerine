// WebSocket route for interactive terminal access to a task's worktree.
// Uses bun-pty + dtach for persistent sessions per task.
// dtach keeps the shell alive across WebSocket disconnects — navigating away
// and back re-attaches to the same session with the shell state preserved.
// Unlike tmux, dtach doesn't capture the mouse, so copy/paste and mobile
// scroll work natively in xterm.js.

import { Effect } from "effect"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { spawn } from "bun-pty"
import type { IPty } from "bun-pty"
import type { AppDeps } from "../app"
import { isAuthEnabled, isRequestAuthenticated, isValidAuthToken } from "../../auth"
import { getTask } from "../../db/queries"
import { createLogger } from "../../logger"
import { tmpdir } from "os"
import { join } from "path"

const log = createLogger("terminal-ws")

/** dtach socket path for a given task */
export function dtachSocketPath(taskId: string): string {
  return join(tmpdir(), `tng-${taskId.slice(0, 8)}.dtach`)
}

export function terminalWsRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono()
  type SocketLike = { send(data: string): void; close(code?: number, reason?: string): void }

  app.get(
    "/:id/terminal",
    upgradeWebSocket((c) => {
      const taskId = c.req.param("id")!
      const authEnabled = isAuthEnabled(deps.config)
      const requestAuthenticated = isRequestAuthenticated(c, deps.config)
      let pty: IPty | null = null
      let alive = true
      let authenticated = !authEnabled || requestAuthenticated
      let authTimer: ReturnType<typeof setTimeout> | null = null
      let started = false

      const startTerminal = (ws: SocketLike) => {
        if (started) return
        started = true

        Effect.runPromise(
          Effect.gen(function* () {
            const task = yield* getTask(deps.db, taskId)
            if (!task?.worktree_path) throw new Error("Task has no worktree")

            const worktree = task.worktree_path
            const socketPath = dtachSocketPath(taskId)

            log.info("Terminal session starting", { taskId, worktree, socketPath })

            pty = spawn("dtach", [
              "-A", socketPath,
              "-z",
              "/bin/bash", "--login",
            ], {
              cols: 80,
              rows: 24,
              name: "xterm-256color",
              cwd: worktree,
            })

            pty.onData((data) => {
              if (!alive) return
              try {
                ws.send(JSON.stringify({ type: "output", data }))
              } catch {
                // Client disconnected
              }
            })

            pty.onExit(({ exitCode }) => {
              if (!alive) return
              try {
                ws.send(JSON.stringify({ type: "exit", code: exitCode }))
              } catch {
                // Client gone
              }
            })

            ws.send(JSON.stringify({ type: "connected" }))
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

          if (!authenticated || !pty) return

          if (parsed.type === "input" && parsed.data) {
            pty.write(parsed.data)
          } else if (parsed.type === "resize" && parsed.cols && parsed.rows) {
            pty.resize(parsed.cols, parsed.rows)
          }
        },

        onClose() {
          if (authTimer) clearTimeout(authTimer)
          alive = false
          // Only kill the PTY attachment — the dtach session stays alive
          // so the next connection can re-attach with history preserved.
          if (pty) {
            try {
              pty.kill()
            } catch {
              // Already dead
            }
            pty = null
          }
          log.debug("Terminal detached (dtach session preserved)", { taskId })
        },
      }
    })
  )

  return app
}
