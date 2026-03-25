import { Effect } from "effect"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import type { AppDeps } from "../app"
import { getTask } from "../../db/queries"
import type { WsClientMessage, WsServerMessage, TaskStatus } from "@tangerine/shared"

/**
 * Creates WebSocket routes for task event streaming.
 * Receives upgradeWebSocket from the shared createBunWebSocket() in app.ts.
 */
export function wsRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono()

  app.get(
    "/:id/ws",
    upgradeWebSocket((c) => {
      const taskId = c.req.param("id")!

      // Store unsubscribe functions so we can clean up on close
      let unsubEvent: (() => void) | null = null
      let unsubStatus: (() => void) | null = null

      return {
        onOpen(_event, ws) {
          // Run Effect-based getTask inside callback via runPromise
          Effect.runPromise(getTask(deps.db, taskId)).then(
            (_task) => {
              // Confirm connection
              const connected: WsServerMessage = { type: "connected" }
              ws.send(JSON.stringify(connected))

              // Relay agent events to this client
              unsubEvent = deps.taskManager.onTaskEvent(taskId, (data: unknown) => {
                // Activity events get their own WS message type
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

              // Relay status changes to this client
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
            }
          )
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
          unsubEvent?.()
          unsubStatus?.()
        },
      }
    })
  )

  return app
}
