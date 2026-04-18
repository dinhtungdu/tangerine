import { useState, useEffect, useCallback, useRef } from "react"
import type { Task } from "@tangerine/shared"
import { fetchTasks } from "../lib/api"

const POLL_INTERVAL = 5000
const PAGE_SIZE = 50

interface UseTasksResult {
  tasks: Task[]
  total: number
  page: number
  pageSize: number
  setPage: (page: number | ((prev: number) => number)) => void
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useTasks(filter?: { status?: string; project?: string; search?: string }): UseTasksResult {
  const [tasks, setTasks] = useState<Task[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPageState] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchTrigger, setFetchTrigger] = useState(0)

  // Track previous filter to detect changes and reset page
  const prevFilterRef = useRef<string | undefined>(undefined)
  const filterKey = `${filter?.status}|${filter?.project}|${filter?.search}`

  // Wrapper to support functional updates for rapid clicks
  const setPage = useCallback((pageOrFn: number | ((prev: number) => number)) => {
    setPageState(pageOrFn)
  }, [])

  const refetch = useCallback(() => {
    setFetchTrigger((n) => n + 1)
  }, [])

  // Store filter in ref to avoid object comparison issues in effect deps
  const filterRef = useRef(filter)
  filterRef.current = filter

  useEffect(() => {
    // Reset page to 0 when filter changes, then fetch
    const filterChanged = prevFilterRef.current !== undefined && prevFilterRef.current !== filterKey
    prevFilterRef.current = filterKey
    const effectivePage = filterChanged ? 0 : page
    if (filterChanged) setPageState(0)

    setLoading(true)

    const doFetch = async () => {
      try {
        const data = await fetchTasks({
          ...filterRef.current,
          limit: PAGE_SIZE,
          offset: effectivePage * PAGE_SIZE,
        })
        setTasks(data.tasks)
        setTotal(data.total)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch tasks")
      } finally {
        setLoading(false)
      }
    }

    doFetch()

    const interval = setInterval(doFetch, POLL_INTERVAL)
    function onVisibilityChange() {
      if (document.visibilityState === "visible") doFetch()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", onVisibilityChange) }
  }, [filterKey, page, fetchTrigger])

  return { tasks, total, page, pageSize: PAGE_SIZE, setPage, loading, error, refetch }
}
