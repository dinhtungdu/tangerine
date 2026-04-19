import { Effect } from "effect"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import type { AppDeps } from "../app"
import { createWebSocketHeartbeat, type WebSocketHeartbeat } from "../ws-heartbeat"
import { isAuthEnabled, isRequestAuthenticated, isValidAuthToken } from "../../auth"
import { getTask } from "../../db/queries"
import { getAgentWorkingState, onAgentStatusChange } from "../../tasks/events"
import type { WsClientMessage, WsServerMessage, TaskStatus } from "@tangerine/shared"

/**
 * Creates WebSocket routes for task event streaming.
 * Receives upgradeWebSocket from the shared createBunWebSocket() in app.ts.
 */
export function wsRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono()
  type SocketLike = { send(data: string): void; close(code?: number, reason?: string): void }

  app.get(
    "/:id/ws",
    upgradeWebSocket((c) => {
      const taskId = c.req.param("id")!
      const authEnabled = isAuthEnabled(deps.config)
      const requestAuthenticated = isRequestAuthenticated(c, deps.config)

      // Store unsubscribe functions so we can clean up on close
      let unsubEvent: (() => void) | null = null
      let unsubStatus: (() => void) | null = null
      let heartbeat: WebSocketHeartbeat | null = null
      let authenticated = !authEnabled || requestAuthenticated
      let authTimer: ReturnType<typeof setTimeout> | null = null
      let started = false

      const startStreaming = (ws: SocketLike) => {
        if (started) return
        started = true
        heartbeat = createWebSocketHeartbeat(ws)
        heartbeat.start()

        Effect.runPromise(getTask(deps.db, taskId)).then(
          (task) => {
            const connected: WsServerMessage = { type: "connected" }
            ws.send(JSON.stringify(connected))

            if (task) {
              const statusMsg: WsServerMessage = { type: "status", status: task.status as TaskStatus }
              ws.send(JSON.stringify(statusMsg))

              if (task.status === "running") {
                const agentMsg: WsServerMessage = { type: "agent_status", agentStatus: getAgentWorkingState(taskId) }
                ws.send(JSON.stringify(agentMsg))
              }
            }

            unsubEvent = deps.taskManager.onTaskEvent(taskId, (data: unknown) => {
              const d = data as Record<string, unknown>
              const msg: WsServerMessage = d.type === "activity"
                ? { type: "activity", entry: d.entry as import("@tangerine/shared").ActivityEntry }
                : { type: "event", data }
              try {
                ws.send(JSON.stringify(msg))
              } catch {
                // Client disconnected
              }
            })

            unsubStatus = deps.taskManager.onStatusChange(taskId, (status) => {
              const msg: WsServerMessage = { type: "status", status: status as TaskStatus }
              try {
                ws.send(JSON.stringify(msg))
              } catch {
                // Client disconnected
              }
            })
          },
          () => {
            const msg: WsServerMessage = { type: "error", message: "Task not found" }
            ws.send(JSON.stringify(msg))
            ws.close(1008, "Task not found")
          },
        )
      }

      return {
        onOpen(_event, ws) {
          if (authenticated) {
            startStreaming(ws)
            return
          }
          authTimer = setTimeout(() => {
            const msg: WsServerMessage = { type: "error", message: "Unauthorized" }
            try {
              ws.send(JSON.stringify(msg))
              ws.close(1008, "Unauthorized")
            } catch {
              // Client gone
            }
          }, 5000)
        },

        onMessage(event, ws) {
          let parsed: WsClientMessage
          try {
            const raw = typeof event.data === "string" ? event.data : event.data.toString()
            parsed = JSON.parse(raw) as WsClientMessage
          } catch {
            const msg: WsServerMessage = { type: "error", message: "Invalid JSON" }
            ws.send(JSON.stringify(msg))
            return
          }

          if (parsed.type === "auth") {
            if (!authEnabled || authenticated) return
            if (!isValidAuthToken(deps.config.credentials.tangerineAuthToken!, parsed.token)) {
              const msg: WsServerMessage = { type: "error", message: "Unauthorized" }
              ws.send(JSON.stringify(msg))
              ws.close(1008, "Unauthorized")
              return
            }
            authenticated = true
            if (authTimer) {
              clearTimeout(authTimer)
              authTimer = null
            }
            startStreaming(ws)
            return
          }

          if (parsed.type === "pong") {
            heartbeat?.markAlive()
            return
          }

          if (!authenticated) {
            const msg: WsServerMessage = { type: "error", message: "Unauthorized" }
            ws.send(JSON.stringify(msg))
            ws.close(1008, "Unauthorized")
            return
          }

          heartbeat?.markAlive()

          if (parsed.type === "prompt" && (parsed.text || parsed.images?.length)) {
            Effect.runPromise(
              deps.taskManager.sendPrompt(taskId, parsed.text ?? "", parsed.images)
            ).catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err)
              const msg: WsServerMessage = { type: "error", message }
              try {
                ws.send(JSON.stringify(msg))
              } catch {
                // Client disconnected
              }
            })
          } else if (parsed.type === "abort") {
            Effect.runPromise(
              deps.taskManager.abortTask(taskId)
            ).catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err)
              const msg: WsServerMessage = { type: "error", message }
              try {
                ws.send(JSON.stringify(msg))
              } catch {
                // Client disconnected
              }
            })
          }
        },

        onClose() {
          if (authTimer) clearTimeout(authTimer)
          heartbeat?.stop()
          unsubEvent?.()
          unsubStatus?.()
        },
      }
    })
  )

  // Global agent-status broadcast for task-list live updates
  app.get(
    "/agent-status/ws",
    upgradeWebSocket((c) => {
      const authEnabled = isAuthEnabled(deps.config)
      const requestAuthenticated = isRequestAuthenticated(c, deps.config)
      let authenticated = !authEnabled || requestAuthenticated
      let unsub: (() => void) | null = null
      let authTimer: ReturnType<typeof setTimeout> | null = null

      const startStreaming = (ws: { send(data: string): void }) => {
        const connected: WsServerMessage = { type: "connected" }
        ws.send(JSON.stringify(connected))
        unsub = onAgentStatusChange((ev) => {
          const msg: WsServerMessage = { type: "task_agent_status", taskId: ev.taskId, agentStatus: ev.agentStatus }
          try { ws.send(JSON.stringify(msg)) } catch { /* disconnected */ }
        })
      }

      return {
        onOpen(_event, ws) {
          if (authenticated) { startStreaming(ws); return }
          authTimer = setTimeout(() => {
            try { ws.send(JSON.stringify({ type: "error", message: "Unauthorized" })); ws.close(1008, "Unauthorized") } catch { /* gone */ }
          }, 5000)
        },
        onMessage(event, ws) {
          try {
            const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString()) as WsClientMessage
            if (msg.type === "auth" && !authenticated) {
              if (!isValidAuthToken(deps.config.credentials.tangerineAuthToken!, msg.token)) {
                ws.send(JSON.stringify({ type: "error", message: "Unauthorized" })); ws.close(1008, "Unauthorized"); return
              }
              authenticated = true
              if (authTimer) { clearTimeout(authTimer); authTimer = null }
              startStreaming(ws)
            }
          } catch { /* ignore */ }
        },
        onClose() {
          if (authTimer) clearTimeout(authTimer)
          unsub?.()
        },
      }
    })
  )

  return app
}
