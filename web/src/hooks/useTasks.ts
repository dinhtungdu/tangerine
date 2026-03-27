import { useState, useEffect, useCallback, useRef } from "react"
import type { Task } from "@tangerine/shared"
import { fetchTasks } from "../lib/api"

const POLL_INTERVAL = 5000

interface UseTasksResult {
  tasks: Task[]
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useTasks(filter?: { status?: string; project?: string; search?: string }): UseTasksResult {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const filterRef = useRef(filter)
  filterRef.current = filter

  const refetch = useCallback(async () => {
    try {
      const data = await fetchTasks(filterRef.current)
      setTasks(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch tasks")
    } finally {
      setLoading(false)
    }
  }, [])

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

  return { tasks, loading, error, refetch }
}
