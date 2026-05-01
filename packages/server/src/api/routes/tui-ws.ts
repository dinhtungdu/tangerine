// WebSocket route for TUI terminal access (agent native TUI via PTY).
// Reuses the same xterm.js protocol as terminal-ws but connects to the TUI PTY session.

import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import type { AppDeps } from "../app"
import { createWebSocketHeartbeat, type WebSocketHeartbeat } from "../ws-heartbeat"
import { isAuthEnabled, isRequestAuthenticated, isValidAuthToken } from "../../auth"
import {
  getTuiSession,
  addTuiClient,
  removeTuiClient,
  drainPendingTuiOutput,
  type BufferedTuiClient,
} from "../../tasks/tui"
import { createLogger } from "../../logger"

const log = createLogger("tui-ws")

type TuiSocket = { send(data: string): void; close(code?: number, reason?: string): void }

export function tuiWsRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono()

  const socketRoute = () =>
    upgradeWebSocket((c) => {
      const taskId = c.req.param("id")!
      const authEnabled = isAuthEnabled(deps.config)
      const requestAuthenticated = isRequestAuthenticated(c, deps.config)
      let client: BufferedTuiClient | null = null
      let heartbeat: WebSocketHeartbeat | null = null
      let authenticated = !authEnabled || requestAuthenticated
      let authTimer: ReturnType<typeof setTimeout> | null = null
      let started = false

      const startTuiTerminal = (ws: TuiSocket) => {
        if (started) return
        started = true
        heartbeat = createWebSocketHeartbeat(ws)
        heartbeat.start()

        const session = getTuiSession(taskId)
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "TUI not active" }))
          ws.close(1011, "TUI not active")
          return
        }

        client = addTuiClient(taskId, ws)

        try {
          if (session.scrollback) {
            ws.send(JSON.stringify({ type: "scrollback", data: session.scrollback }))
          }
          client.ready = true
          const pending = drainPendingTuiOutput(client)
          if (pending) {
            ws.send(JSON.stringify({ type: "output", data: pending }))
          }
          ws.send(JSON.stringify({ type: "connected" }))
        } catch {
          removeTuiClient(taskId, client)
        }
      }

      return {
        onOpen(_event, ws) {
          if (authenticated) {
            startTuiTerminal(ws)
            return
          }
          authTimer = setTimeout(() => {
            try {
              ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }))
              ws.close(1008, "Unauthorized")
            } catch { /* gone */ }
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
              } catch { /* gone */ }
              return
            }
            authenticated = true
            if (authTimer) {
              clearTimeout(authTimer)
              authTimer = null
            }
            startTuiTerminal(ws)
            return
          }

          if (parsed.type === "pong") {
            heartbeat?.markAlive()
            return
          }

          if (!authenticated) return

          const session = getTuiSession(taskId)
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
          removeTuiClient(taskId, client)
          log.debug("TUI client detached (session continues)", { taskId })
        },
      }
    })

  app.get("/:id/tui-terminal", socketRoute())

  return app
}
