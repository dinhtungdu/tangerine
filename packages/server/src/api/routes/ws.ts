import { Effect } from "effect"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import type { AppDeps } from "../app"
import { mapTaskRow } from "../helpers"
import { createWebSocketHeartbeat, type WebSocketHeartbeat } from "../ws-heartbeat"
import { isAuthEnabled, isRequestAuthenticated, isValidAuthToken } from "../../auth"
import { getTask, listTasks, countTasksByProject } from "../../db/queries"
import { getAgentWorkingState, onTaskListEvent, type TaskListEvent } from "../../tasks/events"
import type { WsClientMessage, WsServerMessage, TaskStatus, Task } from "@tangerine/shared"

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

  return app
}

/**
 * WebSocket route for streaming the global task list.
 * Mounted at /api/ws — endpoint is GET /api/ws/tasks.
 * Accepts optional query params: status, search (project filtering is applied client-side).
 * Sends an initial snapshot, then incremental create/update/delete events plus refreshed counts.
 */
export function taskListWsRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono()
  type SocketLike = { send(data: string): void; close(code?: number, reason?: string): void }

  app.get(
    "/tasks",
    upgradeWebSocket((c) => {
      const status = c.req.query("status") || undefined
      const search = c.req.query("search") || undefined
      const authEnabled = isAuthEnabled(deps.config)
      const requestAuthenticated = isRequestAuthenticated(c, deps.config)

      let unsub: (() => void) | null = null
      let heartbeat: WebSocketHeartbeat | null = null
      let authenticated = !authEnabled || requestAuthenticated
      let authTimer: ReturnType<typeof setTimeout> | null = null
      let started = false

      const searchNormalized = search?.startsWith("#") ? search.slice(1) : search

      // Match the same filters the REST /api/tasks endpoint applies
      const matchesFilter = (task: { status: string; title: string; description: string | null; branch: string | null; prUrl: string | null }) => {
        if (status && task.status !== status) return false
        if (searchNormalized) {
          const needle = searchNormalized.toLowerCase()
          const hay = [task.title, task.description, task.branch, task.prUrl]
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.toLowerCase())
          if (!hay.some((v) => v.includes(needle))) return false
        }
        return true
      }

      const startStreaming = (ws: SocketLike) => {
        if (started) return
        started = true
        heartbeat = createWebSocketHeartbeat(ws)
        heartbeat.start()

        Effect.runPromise(
          Effect.all({
            rows: listTasks(deps.db, { status, search }),
            counts: countTasksByProject(deps.db, { status, search }),
          })
        ).then(
          ({ rows, counts }) => {
            const tasks: Task[] = rows.map(mapTaskRow)
            const connected: WsServerMessage = { type: "connected" }
            ws.send(JSON.stringify(connected))
            const snapshot: WsServerMessage = { type: "tasks_snapshot", tasks, counts }
            ws.send(JSON.stringify(snapshot))

            unsub = onTaskListEvent((event: TaskListEvent) => {
              try {
                if (event.kind === "deleted") {
                  Effect.runPromise(countTasksByProject(deps.db, { status, search })).then((c) => {
                    const msg: WsServerMessage = { type: "task_deleted", taskId: event.taskId, projectId: event.projectId, counts: c }
                    try { ws.send(JSON.stringify(msg)) } catch { /* client gone */ }
                  }).catch(() => { /* ignore count errors */ })
                  return
                }

                const task = mapTaskRow(event.task)
                if (!matchesFilter(task)) {
                  // Task no longer matches filter — treat as delete if it was previously in scope.
                  // Client handles unknown ids gracefully.
                  if (event.kind === "updated") {
                    Effect.runPromise(countTasksByProject(deps.db, { status, search })).then((c) => {
                      const msg: WsServerMessage = { type: "task_deleted", taskId: task.id, projectId: task.projectId, counts: c }
                      try { ws.send(JSON.stringify(msg)) } catch { /* client gone */ }
                    }).catch(() => { /* ignore */ })
                  }
                  return
                }

                if (event.kind === "created") {
                  Effect.runPromise(countTasksByProject(deps.db, { status, search })).then((c) => {
                    const msg: WsServerMessage = { type: "task_created", task, counts: c }
                    try { ws.send(JSON.stringify(msg)) } catch { /* client gone */ }
                  }).catch(() => { /* ignore */ })
                } else {
                  const msg: WsServerMessage = { type: "task_updated", task }
                  try { ws.send(JSON.stringify(msg)) } catch { /* client gone */ }
                }
              } catch {
                // Never let a listener crash propagate
              }
            })
          },
          () => {
            const msg: WsServerMessage = { type: "error", message: "Failed to load tasks" }
            try { ws.send(JSON.stringify(msg)) } catch { /* client gone */ }
            ws.close(1011, "Snapshot failed")
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

          // Other client messages are not supported on this endpoint — ignore silently.
          heartbeat?.markAlive()
        },

        onClose() {
          if (authTimer) clearTimeout(authTimer)
          heartbeat?.stop()
          unsub?.()
        },
      }
    })
  )

  return app
}
