import { useState, useEffect, useCallback, useRef } from "react"
import type { Task } from "@tangerine/shared"
import { fetchTasks, fetchTaskCounts } from "../lib/api"

const POLL_INTERVAL = 5000
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

  useEffect(() => {
    setLoading(true)
    refetch()

    const interval = setInterval(refetch, POLL_INTERVAL)
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refetch()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", onVisibilityChange) }
  }, [filter?.status, filter?.project, filter?.search, refetch])

  const tasks = Object.values(tasksByProject).flat()
  const loadedCounts: Record<string, number> = {}
  for (const [projectId, projectTasks] of Object.entries(tasksByProject)) {
    loadedCounts[projectId] = projectTasks.length
  }

  return { tasks, loading, error, refetch, counts, loadedCounts, loadMore }
}
