import { useState, useEffect, useCallback, useRef } from "react"
import type { Task } from "@tangerine/shared"
import { fetchTasks, fetchTaskCounts } from "../lib/api"
import { useTaskListStream } from "./useTaskListStream"

// Polling is a fallback — only used when the task-list WebSocket is not connected.
const FALLBACK_POLL_INTERVAL = 5000
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

  const refetch = useCallback(async () => {
    try {
      const countsData = await fetchTaskCounts({
        status: filterRef.current?.status,
        search: filterRef.current?.search,
      })
      setCounts(countsData)

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
    if (loadingRef.current.has(projectId)) return
    loadingRef.current.add(projectId)

    try {
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
        loadedLimitsRef.current[projectId] = newTasks.length
        return { ...prev, [projectId]: newTasks }
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more tasks")
    } finally {
      loadingRef.current.delete(projectId)
    }
  }, [tasksByProject])

  const refetchRef = useRef(refetch)
  refetchRef.current = refetch

  // Kick off the initial REST fetch so UI shows data even before the WS snapshot arrives.
  useEffect(() => {
    setLoading(true)
    void refetchRef.current()
  }, [filter?.status, filter?.project, filter?.search])

  // Polling fallback: only runs while the WebSocket is disconnected.
  const [wsConnected, setWsConnected] = useState(false)
  useEffect(() => {
    if (wsConnected) return
    const id = setInterval(() => {
      void refetchRef.current()
    }, FALLBACK_POLL_INTERVAL)
    return () => clearInterval(id)
  }, [wsConnected])

  useTaskListStream(
    { status: filter?.status, search: filter?.search, project: filter?.project },
    {
      onConnect: () => setWsConnected(true),
      onDisconnect: () => setWsConnected(false),
      onVisible: () => { void refetchRef.current() },
      onSnapshot: (tasks, newCounts) => {
        const grouped: Record<string, Task[]> = {}
        for (const t of tasks) {
          const bucket = grouped[t.projectId] ?? []
          bucket.push(t)
          grouped[t.projectId] = bucket
        }
        setTasksByProject(grouped)
        setCounts(newCounts)
        setError(null)
        setLoading(false)
      },
      onCreate: (task, newCounts) => {
        setTasksByProject((prev) => {
          const existing = prev[task.projectId] ?? []
          if (existing.some((t) => t.id === task.id)) return prev
          return { ...prev, [task.projectId]: [task, ...existing] }
        })
        setCounts(newCounts)
      },
      onUpdate: (task) => {
        setTasksByProject((prev) => {
          const existing = prev[task.projectId] ?? []
          const idx = existing.findIndex((t) => t.id === task.id)
          if (idx === -1) return { ...prev, [task.projectId]: [task, ...existing] }
          const next = existing.slice()
          next[idx] = { ...next[idx], ...task }
          return { ...prev, [task.projectId]: next }
        })
      },
      onDelete: (taskId, projectId, newCounts) => {
        setTasksByProject((prev) => {
          const existing = prev[projectId] ?? []
          const filtered = existing.filter((t) => t.id !== taskId)
          if (filtered.length === existing.length) {
            // Fallback: check every bucket in case projectId was stale.
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
      },
      onAgentStatus: (taskId, agentStatus) => {
        setTasksByProject((prev) => {
          for (const [pid, list] of Object.entries(prev)) {
            const idx = list.findIndex((t) => t.id === taskId)
            if (idx === -1) continue
            const target = list[idx]
            if (!target) continue
            const next = list.slice()
            next[idx] = { ...target, agentStatus }
            return { ...prev, [pid]: next }
          }
          return prev
        })
      },
    },
  )

  const tasks = Object.values(tasksByProject).flat()
  const loadedCounts: Record<string, number> = {}
  for (const [projectId, projectTasks] of Object.entries(tasksByProject)) {
    loadedCounts[projectId] = projectTasks.length
  }

  return { tasks, loading, error, refetch, counts, loadedCounts, loadMore }
}
