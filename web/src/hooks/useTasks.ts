import { useState, useEffect, useCallback, useRef } from "react"
import type { Task, WsServerMessage, WsClientMessage } from "@tangerine/shared"
import { fetchTasks, fetchTaskCounts } from "../lib/api"
import { emitAuthFailure, getAuthToken } from "../lib/auth"

// Polling is a fallback — only used when the task-list WebSocket is not connected.
const FALLBACK_POLL_INTERVAL = 5000
const PAGE_SIZE = 50
const MAX_BACKOFF = 30000

interface UseTasksResult {
  tasks: Task[]
  loading: boolean
  error: string | null
  refetch: () => void
  counts: Record<string, number>
  loadedCounts: Record<string, number>
  loadMore: (projectId: string) => Promise<void>
}

export function useTasks(filter?: { status?: string; project?: string; search?: string }): UseTasksResult {
  const [tasksByProject, setTasksByProject] = useState<Record<string, Task[]>>({})
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const filterRef = useRef(filter)
  filterRef.current = filter

  // Track loaded limits per project to preserve pagination across refetches
  const loadedLimitsRef = useRef<Record<string, number>>({})
  // Track in-flight loads to prevent double-clicks
  const loadingRef = useRef<Set<string>>(new Set())

  const refetch = useCallback(async () => {
    try {
      const countsData = await fetchTaskCounts({
        status: filterRef.current?.status,
        search: filterRef.current?.search,
      })
      setCounts(countsData)

      // Fetch tasks for each project up to the limit we've loaded (or PAGE_SIZE for new projects)
      const projectIds = Object.keys(countsData)
      const fetchPromises = projectIds.map(async (projectId) => {
        const limit = Math.max(loadedLimitsRef.current[projectId] ?? PAGE_SIZE, PAGE_SIZE)
        const tasks = await fetchTasks({
          ...filterRef.current,
          project: projectId,
          limit,
        })
        return { projectId, tasks }
      })

      const results = await Promise.all(fetchPromises)
      const grouped: Record<string, Task[]> = {}
      for (const { projectId, tasks } of results) {
        grouped[projectId] = tasks
      }
      setTasksByProject(grouped)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch tasks")
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMore = useCallback(async (projectId: string) => {
    // Synchronous check using ref to prevent double-clicks
    if (loadingRef.current.has(projectId)) return
    loadingRef.current.add(projectId)

    try {
      // Use functional setState to get latest offset
      const currentTasks = tasksByProject[projectId] ?? []
      const offset = currentTasks.length

      const moreTasks = await fetchTasks({
        ...filterRef.current,
        project: projectId,
        limit: PAGE_SIZE,
        offset,
      })

      setTasksByProject((prev) => {
        const existing = prev[projectId] ?? []
        const newTasks = [...existing, ...moreTasks]
        // Update loaded limit so refetch preserves this pagination
        loadedLimitsRef.current[projectId] = newTasks.length
        return { ...prev, [projectId]: newTasks }
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more tasks")
    } finally {
      loadingRef.current.delete(projectId)
    }
  }, [tasksByProject])

  // Store refetch in a ref so the WS effect can trigger initial load without
  // re-running when filters change its identity.
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch

  // WebSocket subscription for incremental task-list updates.
  // Falls back to periodic polling when the socket is not connected (e.g. during
  // reconnect backoff or in environments where WebSockets aren't available).
  useEffect(() => {
    setLoading(true)

    const projectFilter = filter?.project
    const passesClientFilter = (task: Task) => !projectFilter || task.projectId === projectFilter

    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let backoff = 1000
    let unmounted = false
    let wsConnected = false

    // Kick off the initial REST fetch so UI shows data even before the WS snapshot arrives.
    void refetchRef.current()

    const startPolling = () => {
      if (pollTimer) return
      pollTimer = setInterval(() => {
        void refetchRef.current()
      }, FALLBACK_POLL_INTERVAL)
    }

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    const applyCreate = (task: Task, newCounts: Record<string, number>) => {
      if (!passesClientFilter(task)) {
        setCounts(newCounts)
        return
      }
      setTasksByProject((prev) => {
        const existing = prev[task.projectId] ?? []
        if (existing.some((t) => t.id === task.id)) return prev
        return { ...prev, [task.projectId]: [task, ...existing] }
      })
      setCounts(newCounts)
    }

    const applyUpdate = (task: Task) => {
      if (!passesClientFilter(task)) return
      setTasksByProject((prev) => {
        const existing = prev[task.projectId] ?? []
        const idx = existing.findIndex((t) => t.id === task.id)
        if (idx === -1) {
          // Task not in any project bucket yet (e.g. filter widened). Add it at top.
          return { ...prev, [task.projectId]: [task, ...existing] }
        }
        const next = existing.slice()
        next[idx] = { ...next[idx], ...task }
        return { ...prev, [task.projectId]: next }
      })
    }

    const applyDelete = (taskId: string, projectId: string, newCounts: Record<string, number>) => {
      setTasksByProject((prev) => {
        const existing = prev[projectId] ?? []
        const filtered = existing.filter((t) => t.id !== taskId)
        if (filtered.length === existing.length) {
          // Not found in the stored project bucket — check every bucket as a fallback.
          let changed = false
          const next: Record<string, Task[]> = {}
          for (const [pid, list] of Object.entries(prev)) {
            const f = list.filter((t) => t.id !== taskId)
            if (f.length !== list.length) changed = true
            next[pid] = f
          }
          return changed ? next : prev
        }
        return { ...prev, [projectId]: filtered }
      })
      setCounts(newCounts)
    }

    const connect = () => {
      if (unmounted) return
      const params = new URLSearchParams()
      if (filter?.status) params.set("status", filter.status)
      if (filter?.search) params.set("search", filter.search)
      const qs = params.toString() ? `?${params}` : ""
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
      const url = `${protocol}//${window.location.host}/api/ws/tasks${qs}`

      let socket: WebSocket
      try {
        socket = new WebSocket(url)
      } catch {
        startPolling()
        return
      }
      ws = socket

      socket.onopen = () => {
        if (unmounted) return
        const token = getAuthToken()
        if (token) {
          const msg: WsClientMessage = { type: "auth", token }
          socket.send(JSON.stringify(msg))
        }
        wsConnected = true
        stopPolling()
        backoff = 1000
      }

      socket.onmessage = (event) => {
        if (unmounted) return
        let msg: WsServerMessage
        try {
          msg = JSON.parse(event.data as string) as WsServerMessage
        } catch {
          return
        }

        if (msg.type === "ping") {
          const pong: WsClientMessage = { type: "pong" }
          socket.send(JSON.stringify(pong))
          return
        }
        if (msg.type === "error") {
          if (msg.message === "Unauthorized") emitAuthFailure()
          return
        }
        if (msg.type === "tasks_snapshot") {
          const grouped: Record<string, Task[]> = {}
          for (const t of msg.tasks) {
            if (!passesClientFilter(t)) continue
            const bucket = grouped[t.projectId] ?? []
            bucket.push(t)
            grouped[t.projectId] = bucket
          }
          setTasksByProject(grouped)
          setCounts(msg.counts)
          setError(null)
          setLoading(false)
          return
        }
        if (msg.type === "task_created") {
          applyCreate(msg.task, msg.counts)
          return
        }
        if (msg.type === "task_updated") {
          applyUpdate(msg.task)
          return
        }
        if (msg.type === "task_deleted") {
          applyDelete(msg.taskId, msg.projectId, msg.counts)
          return
        }
      }

      socket.onerror = () => {
        // onclose fires afterwards and handles reconnect/fallback.
      }

      socket.onclose = () => {
        if (unmounted) return
        if (ws === socket) ws = null
        wsConnected = false
        startPolling()
        const delay = backoff
        backoff = Math.min(delay * 2, MAX_BACKOFF)
        reconnectTimer = setTimeout(connect, delay)
      }
    }

    connect()

    function onVisibilityChange() {
      if (document.visibilityState !== "visible" || unmounted) return
      // Refresh immediately on visibility change — cheap when WS is connected (snapshot via REST is discarded).
      void refetchRef.current()
      if (!wsConnected && (!ws || ws.readyState >= WebSocket.CLOSING)) {
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
      stopPolling()
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
        ws = null
      }
    }
  }, [filter?.status, filter?.project, filter?.search])

  const tasks = Object.values(tasksByProject).flat()
  const loadedCounts: Record<string, number> = {}
  for (const [projectId, projectTasks] of Object.entries(tasksByProject)) {
    loadedCounts[projectId] = projectTasks.length
  }

  return { tasks, loading, error, refetch, counts, loadedCounts, loadMore }
}
