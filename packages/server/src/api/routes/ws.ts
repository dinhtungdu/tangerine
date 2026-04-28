import { Effect } from "effect"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import type { AppDeps } from "../app"
import { createWebSocketHeartbeat, type WebSocketHeartbeat } from "../ws-heartbeat"
import { isAuthEnabled, isRequestAuthenticated, isValidAuthToken } from "../../auth"
import { getTask } from "../../db/queries"
import { getAgentWorkingState, onAgentStatusChange, onTaskListChange } from "../../tasks/events"
import { getTaskState } from "../../tasks/task-state"
import { getQueuedPrompts, onQueueChange } from "../../agent/prompt-queue"
import type { WsClientMessage, WsServerMessage, TaskStatus } from "@tangerine/shared"

/**
 * Creates WebSocket routes for task event streaming.
 * Receives upgradeWebSocket from the shared createBunWebSocket() in app.ts.
 */
type InitialTaskSnapshot = { status: string } | null

type SocketLike = { send(data: string): void; close(code?: number, reason?: string): void }

export function initialTaskStreamMessages(taskId: string, task: InitialTaskSnapshot): WsServerMessage[] {
  const messages: WsServerMessage[] = [{ type: "connected" }]
  if (!task) return messages

  messages.push({ type: "status", status: task.status as TaskStatus })

  if (task.status === "running") {
    messages.push({ type: "agent_status", agentStatus: getAgentWorkingState(taskId) })
  }

  const state = getTaskState(taskId)
  if (state.configOptions.length > 0) {
    messages.push({ type: "event", data: { event: "config.options", configOptions: state.configOptions } })
  }
  messages.push({ type: "event", data: { event: "slash.commands", commands: state.slashCommands } })

  return messages
}

export function wsRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono()

  const taskListSocket = () => upgradeWebSocket((c) => {
    const authEnabled = isAuthEnabled(deps.config)
    const requestAuthenticated = isRequestAuthenticated(c, deps.config)
    let authenticated = !authEnabled || requestAuthenticated
    let unsubAgentStatus: (() => void) | null = null
    let unsubTaskList: (() => void) | null = null
    let authTimer: ReturnType<typeof setTimeout> | null = null
    let started = false

    const startStreaming = (ws: { send(data: string): void; close(code?: number, reason?: string): void }) => {
      if (started) return
      started = true
      const connected: WsServerMessage = { type: "connected" }
      ws.send(JSON.stringify(connected))
      unsubAgentStatus = onAgentStatusChange((ev) => {
        const msg: WsServerMessage = { type: "task_agent_status", taskId: ev.taskId, agentStatus: ev.agentStatus }
        try { ws.send(JSON.stringify(msg)) } catch { /* disconnected */ }
      })
      unsubTaskList = onTaskListChange((ev) => {
        const msg: WsServerMessage = { type: "task_changed", taskId: ev.taskId, change: ev.change }
        try { ws.send(JSON.stringify(msg)) } catch { /* disconnected */ }
      })
    }

    return {
      onOpen(_event, ws) {
        if (authenticated) {
          startStreaming(ws)
          return
        }
        authTimer = setTimeout(() => {
          try {
            ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }))
            ws.close(1008, "Unauthorized")
          } catch {
            // Client gone
          }
        }, 5000)
      },
      onMessage(event, ws) {
        try {
          const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString()) as WsClientMessage
          if (msg.type === "auth" && !authenticated) {
            if (!isValidAuthToken(deps.config.credentials.tangerineAuthToken!, msg.token)) {
              ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }))
              ws.close(1008, "Unauthorized")
              return
            }
            authenticated = true
            if (authTimer) {
              clearTimeout(authTimer)
              authTimer = null
            }
            startStreaming(ws)
          }
        } catch {
          // Ignore malformed non-auth messages on this read-only stream
        }
      },
      onClose() {
        if (authTimer) clearTimeout(authTimer)
        unsubAgentStatus?.()
        unsubTaskList?.()
      },
    }
  })

  // Global task-list broadcast for runs/sidebar live updates.
  app.get("/list/ws", taskListSocket())

  // Backward-compatible path for older clients that only consumed agent status.
  app.get("/agent-status/ws", taskListSocket())

  app.get(
    "/:id/ws",
    upgradeWebSocket((c) => {
      const taskId = c.req.param("id")!
      const authEnabled = isAuthEnabled(deps.config)
      const requestAuthenticated = isRequestAuthenticated(c, deps.config)

      // Store unsubscribe functions so we can clean up on close
      let unsubEvent: (() => void) | null = null
      let unsubStatus: (() => void) | null = null
      let unsubQueue: (() => void) | null = null
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
            for (const msg of initialTaskStreamMessages(taskId, task)) {
              ws.send(JSON.stringify(msg))
            }

            if (task) {
              Effect.runPromise(getQueuedPrompts(taskId)).then((queuedPrompts) => {
                const queueMsg: WsServerMessage = { type: "queue", queuedPrompts }
                try { ws.send(JSON.stringify(queueMsg)) } catch { /* disconnected */ }
              }).catch(() => undefined)

              unsubQueue = onQueueChange(taskId, (queuedPrompts) => {
                const queueMsg: WsServerMessage = { type: "queue", queuedPrompts }
                try { ws.send(JSON.stringify(queueMsg)) } catch { /* disconnected */ }
              })
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
          unsubQueue?.()
        },
      }
    })
  )

  return app
}
