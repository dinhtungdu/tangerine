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

  const refetch = useCallback(async () => {
    try {
      const [countsData, tasksData] = await Promise.all([
        fetchTaskCounts({ status: filterRef.current?.status, search: filterRef.current?.search }),
        fetchTasks({ ...filterRef.current, limit: PAGE_SIZE }),
      ])
      setCounts(countsData)
      const grouped: Record<string, Task[]> = {}
      for (const task of tasksData) {
        const arr = grouped[task.projectId] ?? (grouped[task.projectId] = [])
        arr.push(task)
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
    const currentTasks = tasksByProject[projectId] ?? []
    const offset = currentTasks.length
    try {
      const moreTasks = await fetchTasks({
        ...filterRef.current,
        project: projectId,
        limit: PAGE_SIZE,
        offset,
      })
      setTasksByProject((prev) => ({
        ...prev,
        [projectId]: [...(prev[projectId] ?? []), ...moreTasks],
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more tasks")
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
