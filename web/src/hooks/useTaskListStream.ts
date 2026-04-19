import { useEffect, useRef } from "react"
import type { Task, WsServerMessage, WsClientMessage } from "@tangerine/shared"
import { emitAuthFailure, getAuthToken } from "../lib/auth"

const MAX_BACKOFF = 30000

export interface TaskListStreamHandlers {
  onSnapshot(tasks: Task[], counts: Record<string, number>): void
  onCreate(task: Task, counts: Record<string, number>): void
  onUpdate(task: Task): void
  onDelete(taskId: string, projectId: string, counts: Record<string, number>): void
  onAgentStatus(taskId: string, agentStatus: "idle" | "working"): void
  /** Called when the stream disconnects (consumers may fall back to polling). */
  onDisconnect?(): void
  /** Called when the stream reconnects successfully. */
  onConnect?(): void
  /** Called when the visibility:visible event fires, whether or not WS is connected. */
  onVisible?(): void
  /**
   * Optional per-connection row cap override, evaluated each time the
   * socket opens. Lets callers preserve "load more" pagination across
   * reconnects without putting the limit in useEffect deps (which would
   * force a reconnect on every page click).
   */
  getLimit?(): number | undefined
}

export interface TaskListStreamFilter {
  status?: string
  search?: string
  project?: string
}

/**
 * Opens a WebSocket to /api/ws/tasks and drives the caller's state via the
 * supplied handlers. Owns reconnect with exponential backoff, auth handshake,
 * and ping/pong. Re-runs when filter changes (closes the old socket, opens a
 * new one with updated query params).
 */
export function useTaskListStream(filter: TaskListStreamFilter, handlers: TaskListStreamHandlers): void {
  // Keep handlers current without re-running the effect when the parent
  // recreates them each render.
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let backoff = 1000
    let unmounted = false

    const connect = () => {
      if (unmounted) return
      const params = new URLSearchParams()
      if (filter.status) params.set("status", filter.status)
      if (filter.search) params.set("search", filter.search)
      if (filter.project) params.set("project", filter.project)
      const limit = handlersRef.current.getLimit?.()
      if (limit && limit > 0) params.set("limit", String(limit))
      const qs = params.toString() ? `?${params}` : ""
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
      const url = `${protocol}//${window.location.host}/api/ws/tasks${qs}`

      let socket: WebSocket
      try {
        socket = new WebSocket(url)
      } catch {
        handlersRef.current.onDisconnect?.()
        if (reconnectTimer) clearTimeout(reconnectTimer)
        const delay = backoff
        backoff = Math.min(delay * 2, MAX_BACKOFF)
        reconnectTimer = setTimeout(connect, delay)
        return
      }
      ws = socket
      // Don't treat the socket as "connected" (and disable polling fallback)
      // until the server has accepted our auth and delivered a real message.
      // A bare TCP upgrade with an expired token would otherwise look healthy
      // to useTasks while the server is about to close the socket for auth
      // failure, leaving the list frozen.
      let handshakeCompleted = false
      const onServerHandshake = () => {
        if (handshakeCompleted) return
        handshakeCompleted = true
        backoff = 1000
        handlersRef.current.onConnect?.()
      }

      socket.onopen = () => {
        if (unmounted) return
        const token = getAuthToken()
        if (token) {
          const msg: WsClientMessage = { type: "auth", token }
          socket.send(JSON.stringify(msg))
        }
      }

      socket.onmessage = (event) => {
        if (unmounted) return
        let msg: WsServerMessage
        try {
          msg = JSON.parse(event.data as string) as WsServerMessage
        } catch {
          return
        }

        switch (msg.type) {
          case "ping": {
            const pong: WsClientMessage = { type: "pong" }
            socket.send(JSON.stringify(pong))
            return
          }
          case "error":
            if (msg.message === "Unauthorized") emitAuthFailure()
            return
          case "connected":
            onServerHandshake()
            return
          case "tasks_snapshot":
            onServerHandshake()
            handlersRef.current.onSnapshot(msg.tasks, msg.counts)
            return
          case "task_created":
            handlersRef.current.onCreate(msg.task, msg.counts)
            return
          case "task_updated":
            handlersRef.current.onUpdate(msg.task)
            return
          case "task_deleted":
            handlersRef.current.onDelete(msg.taskId, msg.projectId, msg.counts)
            return
          case "task_agent_status":
            handlersRef.current.onAgentStatus(msg.taskId, msg.agentStatus)
            return
          default:
            return
        }
      }

      socket.onerror = () => {
        // onclose fires afterwards and handles reconnect.
      }

      socket.onclose = () => {
        if (unmounted) return
        if (ws === socket) ws = null
        handlersRef.current.onDisconnect?.()
        const delay = backoff
        backoff = Math.min(delay * 2, MAX_BACKOFF)
        reconnectTimer = setTimeout(connect, delay)
      }
    }

    connect()

    function onVisibilityChange() {
      if (document.visibilityState !== "visible" || unmounted) return
      handlersRef.current.onVisible?.()
      if (!ws || ws.readyState >= WebSocket.CLOSING) {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        backoff = 1000
        connect()
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      unmounted = true
      document.removeEventListener("visibilitychange", onVisibilityChange)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
        ws = null
      }
    }
  }, [filter.status, filter.search, filter.project])
}
