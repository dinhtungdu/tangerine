import { Effect } from "effect"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import type { AppDeps } from "../app"
import { mapTaskRow, taskMatchesFilter } from "../helpers"
import { createWebSocketHeartbeat, type WebSocketHeartbeat } from "../ws-heartbeat"
import { isAuthEnabled, isRequestAuthenticated, isValidAuthToken } from "../../auth"
import { getTask, listTasks, listTasksPerProjectCapped, countTasksByProject } from "../../db/queries"
import { getAgentWorkingState, hasAgentWorkingState, onTaskListEvent, type TaskListEvent } from "../../tasks/events"
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
 * Accepts optional query params: status, search, project.
 * Sends an initial snapshot, then incremental create/update/delete events
 * plus refreshed counts (batched: counts queries are coalesced across bursts).
 */
export function taskListWsRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono()
  type SocketLike = { send(data: string): void; close(code?: number, reason?: string): void }

  // Coalesce bursts of mutations into a single counts query — a dozen rapid
  // status transitions should emit one SQL COUNT, not a dozen. Messages that
  // need counts are queued and flushed together.
  const COUNTS_FLUSH_MS = 20
  // Mirrors the REST pagination: PAGE_SIZE per project in the snapshot.
  const DEFAULT_PER_PROJECT_LIMIT = 50
  // Hard cap on the ?limit= override so a client can't force a multi-thousand
  // row snapshot that would defeat the point of paginating the WS stream.
  const MAX_PER_PROJECT_LIMIT = 500

  app.get(
    "/tasks",
    upgradeWebSocket((c) => {
      const status = c.req.query("status") || undefined
      const search = c.req.query("search") || undefined
      const project = c.req.query("project") || undefined
      const limitRaw = c.req.query("limit")
      const parsedLimit = limitRaw ? parseInt(limitRaw, 10) : NaN
      const perProjectLimit = !isNaN(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, MAX_PER_PROJECT_LIMIT)
        : DEFAULT_PER_PROJECT_LIMIT
      const authEnabled = isAuthEnabled(deps.config)
      const requestAuthenticated = isRequestAuthenticated(c, deps.config)

      let unsub: (() => void) | null = null
      let heartbeat: WebSocketHeartbeat | null = null
      let authenticated = !authEnabled || requestAuthenticated
      let authTimer: ReturnType<typeof setTimeout> | null = null
      let started = false

      const countsFilter = { status, search }
      const listFilter = { status, search, projectId: project, perProjectLimit }
      const memoryFilter = { status, project, search }

      // Track which task ids are currently "in scope" for this connection so
      // updates that enter or leave the filter window turn into create/delete
      // messages (with refreshed counts), not silent no-ops that would let the
      // list and the count badge diverge. inScopeByProject mirrors inScope
      // grouped by projectId so we know whether a project has room in the
      // top-N window for a newly-matching update.
      const inScope = new Set<string>()
      // Ordered per-project list of tracked ids (rank 1 at index 0). Lets us
      // evict the lowest-ranked id when a new arrival would push the project
      // past perProjectLimit, keeping inScope bounded for the lifetime of the
      // connection.
      const inScopeByProject = new Map<string, string[]>()
      const backfillPending = new Set<string>()

      const scopeCount = (projectId: string) => inScopeByProject.get(projectId)?.length ?? 0

      const addToScope = (task: Task, position: "top" | "bottom" = "bottom") => {
        if (inScope.has(task.id)) return
        inScope.add(task.id)
        const list = inScopeByProject.get(task.projectId) ?? []
        if (position === "top") list.unshift(task.id)
        else list.push(task.id)
        inScopeByProject.set(task.projectId, list)
      }
      const removeFromScope = (taskId: string, projectId: string): boolean => {
        if (!inScope.delete(taskId)) return false
        const list = inScopeByProject.get(projectId)
        if (list) {
          const i = list.indexOf(taskId)
          if (i >= 0) list.splice(i, 1)
          if (list.length === 0) inScopeByProject.delete(projectId)
        }
        return true
      }
      // When the project window is full and a new higher-ranked task arrives,
      // the tail id gets displaced. Returns the evicted id (or null).
      const evictTail = (projectId: string): string | null => {
        const list = inScopeByProject.get(projectId)
        if (!list || list.length === 0) return null
        const evicted = list[list.length - 1]
        if (!evicted) return null
        removeFromScope(evicted, projectId)
        return evicted
      }

      // Mirror the augmentation done by GET /api/tasks so the WS payload
      // carries the same agentStatus information as the REST response.
      const withAgentStatus = (task: Task): Task => {
        if (task.status !== "running") return task
        if (task.suspended) return { ...task, agentStatus: "idle" }
        if (hasAgentWorkingState(task.id)) return { ...task, agentStatus: getAgentWorkingState(task.id) }
        return task
      }

      const sendSafe = (ws: SocketLike, msg: WsServerMessage) => {
        try { ws.send(JSON.stringify(msg)) } catch { /* client gone */ }
      }

      // Pending messages that need a counts value attached before being sent.
      type PendingMsg =
        | { kind: "created"; task: Task }
        | { kind: "deleted"; taskId: string; projectId: string }
      const countsQueue: PendingMsg[] = []
      let countsFlushTimer: ReturnType<typeof setTimeout> | null = null
      // Guards against a second COUNT running while the first is still in
      // flight: events arriving mid-query queue up and fire one more flush
      // when the in-flight query resolves, rather than kicking off a
      // concurrent SQL query.
      let countsFlushing = false

      const flushCounts = (ws: SocketLike) => {
        countsFlushTimer = null
        if (countsFlushing || countsQueue.length === 0) return
        const batch = countsQueue.splice(0, countsQueue.length)
        countsFlushing = true
        Effect.runPromise(countTasksByProject(deps.db, countsFilter))
          .then((c) => {
            for (const m of batch) {
              if (m.kind === "created") sendSafe(ws, { type: "task_created", task: m.task, counts: c })
              else sendSafe(ws, { type: "task_deleted", taskId: m.taskId, projectId: m.projectId, counts: c })
            }
          })
          .catch(() => { /* ignore count errors */ })
          .finally(() => {
            countsFlushing = false
            if (countsQueue.length > 0 && !countsFlushTimer) {
              countsFlushTimer = setTimeout(() => flushCounts(ws), COUNTS_FLUSH_MS)
            }
          })
      }

      const queueWithCounts = (ws: SocketLike, msg: PendingMsg) => {
        countsQueue.push(msg)
        if (countsFlushTimer || countsFlushing) return
        countsFlushTimer = setTimeout(() => flushCounts(ws), COUNTS_FLUSH_MS)
      }

      // After removing a row from the top-N window, ask the DB for the row
      // that should slide up into the freed slot. Without this, a client with
      // WebSocket polling disabled stays under-filled after deletions or
      // filter exits until the user manually refreshes.
      const scheduleBackfill = (ws: SocketLike, projectId: string) => {
        if (backfillPending.has(projectId)) return
        const currentCount = scopeCount(projectId)
        if (currentCount >= perProjectLimit) return
        backfillPending.add(projectId)
        Effect.runPromise(
          listTasks(deps.db, { status, search, projectId, limit: 1, offset: currentCount }),
        )
          .then((rows) => {
            backfillPending.delete(projectId)
            const row = rows[0]
            if (!row || inScope.has(row.id)) return
            const task = withAgentStatus(mapTaskRow(row))
            addToScope(task)
            queueWithCounts(ws, { kind: "created", task })
            // More rows may have dropped out while the query was in flight;
            // each queued another scheduleBackfill that was short-circuited
            // by backfillPending. Re-check now that the flag is cleared.
            if (scopeCount(projectId) < perProjectLimit) {
              scheduleBackfill(ws, projectId)
            }
          })
          .catch(() => { backfillPending.delete(projectId) })
      }

      const handleEvent = (ws: SocketLike, event: TaskListEvent) => {
        try {
          if (event.kind === "agent_status") {
            sendSafe(ws, { type: "task_agent_status", taskId: event.taskId, agentStatus: event.agentStatus })
            return
          }
          if (event.kind === "deleted") {
            if (!removeFromScope(event.taskId, event.projectId)) return
            queueWithCounts(ws, { kind: "deleted", taskId: event.taskId, projectId: event.projectId })
            scheduleBackfill(ws, event.projectId)
            return
          }

          const task = withAgentStatus(mapTaskRow(event.task))
          const matches = taskMatchesFilter(task, memoryFilter)
          const wasInScope = inScope.has(task.id)
          // For update events, look at the pre-update row so we can tell
          // whether the row's filter-match state actually changed. Without
          // this distinction, every metadata write on an off-page row (e.g.
          // markTaskSeen) would look identical to a "this row just entered
          // the filter" transition.
          const matchedBefore = event.kind === "updated" && event.prevTask
            ? taskMatchesFilter(mapTaskRow(event.prevTask), memoryFilter)
            : false

          // The streamed view is best-effort: we don't know every row's
          // absolute rank (that would need a per-event re-query), so we
          // handle the precise cases inline and let the client's visibility
          // refetch + reconnect reconcile anything ambiguous.
          if (!matches) {
            // Clean exit from the filter / deletion of a tracked row.
            if (wasInScope || matchedBefore) {
              removeFromScope(task.id, task.projectId)
              queueWithCounts(ws, { kind: "deleted", taskId: task.id, projectId: task.projectId })
              scheduleBackfill(ws, task.projectId)
            }
            return
          }

          if (wasInScope) {
            // In-place update of a tracked row — status changes land here
            // too. We deliberately don't try to re-rank on bucket flips
            // because doing so correctly requires knowing the total
            // matching row count for the project; the visibility refetch
            // catches the rare drift.
            sendSafe(ws, { type: "task_updated", task })
            return
          }

          // Not currently tracked. We admit:
          //  - a brand-new row (newest created_at always sorts to the head,
          //    so it belongs in top-N even when the window is full — the
          //    previous tail is displaced).
          //  - any update whose prev row didn't match the filter *while the
          //    project still has room under the cap*. Without the cap room
          //    guard we can't tell whether an older row's rank-change puts
          //    it above or below the current tail.
          // Everything else (off-page metadata writes, terminal→active on a
          // full project, etc.) is dropped here and reconciled on the next
          // visibility refetch or reconnect.
          const projectCount = scopeCount(task.projectId)
          if (event.kind === "created") {
            if (projectCount >= perProjectLimit) {
              const evicted = evictTail(task.projectId)
              if (evicted) queueWithCounts(ws, { kind: "deleted", taskId: evicted, projectId: task.projectId })
            }
            addToScope(task, "top")
            queueWithCounts(ws, { kind: "created", task })
          } else if (!matchedBefore && projectCount < perProjectLimit) {
            addToScope(task, "bottom")
            queueWithCounts(ws, { kind: "created", task })
          }
        } catch {
          // Never let a listener crash propagate
        }
      }

      const startStreaming = (ws: SocketLike) => {
        if (started) return
        started = true
        heartbeat = createWebSocketHeartbeat(ws)
        heartbeat.start()

        // Subscribe BEFORE loading the snapshot so no events are lost in the gap
        // between "read task rows" and "register subscription". Events that land
        // while the snapshot is loading are buffered, then flushed in order.
        let snapshotSent = false
        const buffered: TaskListEvent[] = []
        unsub = onTaskListEvent((event: TaskListEvent) => {
          if (!snapshotSent) {
            buffered.push(event)
            return
          }
          handleEvent(ws, event)
        })

        Effect.runPromise(
          Effect.all({
            rows: listTasksPerProjectCapped(deps.db, listFilter),
            counts: countTasksByProject(deps.db, countsFilter),
          })
        ).then(
          ({ rows, counts }) => {
            const tasks: Task[] = rows.map((row) => withAgentStatus(mapTaskRow(row)))
            for (const t of tasks) addToScope(t)
            sendSafe(ws, { type: "connected" })
            sendSafe(ws, { type: "tasks_snapshot", tasks, counts })
            snapshotSent = true
            for (const event of buffered) handleEvent(ws, event)
            buffered.length = 0
          },
          () => {
            sendSafe(ws, { type: "error", message: "Failed to load tasks" })
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
          if (countsFlushTimer) {
            clearTimeout(countsFlushTimer)
            countsFlushTimer = null
          }
          countsQueue.length = 0
          backfillPending.clear()
          inScope.clear()
          inScopeByProject.clear()
          heartbeat?.stop()
          unsub?.()
        },
      }
    })
  )

  return app
}
