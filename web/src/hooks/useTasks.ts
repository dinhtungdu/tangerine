import { useState, useEffect, useCallback, useRef } from "react"
import type { Task, WsClientMessage, WsServerMessage } from "@tangerine/shared"
import { fetchTasks, fetchTaskCounts } from "../lib/api"
import { getAuthToken } from "../lib/auth"
import { createHeartbeatMonitor, type HeartbeatMonitor } from "../lib/ws-heartbeat"

const PAGE_SIZE = 50

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
  const refetchInFlightRef = useRef(false)
  const refetchQueuedRef = useRef(false)

  const refetch = useCallback(async () => {
    try {
      const currentFilter = filterRef.current
      const currentProject = currentFilter?.project
      const countsData = await fetchTaskCounts({
        status: currentFilter?.status,
        project: currentProject,
        search: currentFilter?.search,
      })
      const projectCount = currentProject ? countsData[currentProject] : undefined
      const scopedCounts: Record<string, number> = currentProject
        ? (projectCount !== undefined ? { [currentProject]: projectCount } : {})
        : countsData
      setCounts(scopedCounts)

      // Fetch tasks for each project up to the limit we've loaded (or PAGE_SIZE for new projects)
      const projectIds = Object.keys(scopedCounts)
      const fetchPromises = projectIds.map(async (projectId) => {
        const limit = Math.max(loadedLimitsRef.current[projectId] ?? PAGE_SIZE, PAGE_SIZE)
        const tasks = await fetchTasks({
          ...currentFilter,
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
    if (filterRef.current?.project && filterRef.current.project !== projectId) return
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

  const requestRefetch = useCallback(() => {
    if (refetchInFlightRef.current) {
      refetchQueuedRef.current = true
      return
    }

    refetchInFlightRef.current = true
    void refetch().finally(() => {
      refetchInFlightRef.current = false
      if (refetchQueuedRef.current) {
        refetchQueuedRef.current = false
        requestRefetch()
      }
    })
  }, [refetch])

  useEffect(() => {
    setLoading(true)
    requestRefetch()

    function onVisibilityChange() {
      if (document.visibilityState === "visible") requestRefetch()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => { document.removeEventListener("visibilitychange", onVisibilityChange) }
  }, [filter?.status, filter?.project, filter?.search, requestRefetch])

  // Subscribe to task list invalidations and agent status updates via WS.
  useEffect(() => {
    let ws: WebSocket | null = null
    let heartbeat: HeartbeatMonitor | null = null
    let backoff = 1000
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let unmounted = false

    function connect() {
      if (unmounted) return
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/tasks/list/ws`)
      ws = socket

      heartbeat?.stop()
      const socketHeartbeat = createHeartbeatMonitor(() => {
        if (unmounted || ws !== socket) return
        if (socket.readyState < WebSocket.CLOSING) socket.close()
      })
      heartbeat = socketHeartbeat

      socket.onopen = () => {
        socketHeartbeat.markAlive()
        if (unmounted || ws !== socket) return
        backoff = 1000
        const token = getAuthToken()
        if (token) socket.send(JSON.stringify({ type: "auth", token }))
        requestRefetch()
      }

      socket.onmessage = (event) => {
        socketHeartbeat.markAlive()
        if (unmounted || ws !== socket) return
        try {
          const msg = JSON.parse(event.data as string) as WsServerMessage
          if (msg.type === "ping") {
            socket.send(JSON.stringify({ type: "pong" } satisfies WsClientMessage))
            return
          }
          if (msg.type === "task_agent_status") {
            setTasksByProject((prev) => {
              let found = false
              const next: Record<string, Task[]> = {}
              for (const [pid, tasks] of Object.entries(prev)) {
                next[pid] = tasks.map((t) => {
                  if (t.id === msg.taskId) { found = true; return { ...t, agentStatus: msg.agentStatus } }
                  return t
                })
              }
              return found ? next : prev
            })
          } else if (msg.type === "task_changed") {
            requestRefetch()
          }
        } catch { /* ignore */ }
      }

      socket.onclose = () => {
        socketHeartbeat.stop()
        if (heartbeat === socketHeartbeat) heartbeat = null
        if (unmounted || ws !== socket) return
        ws = null
        reconnectTimer = setTimeout(() => { backoff = Math.min(backoff * 2, 5000); connect() }, backoff)
      }
      socket.onerror = () => socket.close()
    }

    connect()
    return () => {
      unmounted = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      heartbeat?.stop()
      ws?.close()
    }
  }, [requestRefetch])

  const tasks = Object.values(tasksByProject).flat()
  const loadedCounts: Record<string, number> = {}
  for (const [projectId, projectTasks] of Object.entries(tasksByProject)) {
    loadedCounts[projectId] = projectTasks.length
  }

  return { tasks, loading, error, refetch, counts, loadedCounts, loadMore }
}
