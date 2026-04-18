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
  setPage: (page: number) => void
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useTasks(filter?: { status?: string; project?: string; search?: string }): UseTasksResult {
  const [tasks, setTasks] = useState<Task[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const filterRef = useRef(filter)
  filterRef.current = filter
  const pageRef = useRef(page)
  pageRef.current = page

  const refetch = useCallback(async () => {
    try {
      const data = await fetchTasks({
        ...filterRef.current,
        limit: PAGE_SIZE,
        offset: pageRef.current * PAGE_SIZE,
      })
      setTasks(data.tasks)
      setTotal(data.total)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch tasks")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setPage(0)
  }, [filter?.status, filter?.project, filter?.search])

  useEffect(() => {
    setLoading(true)
    refetch()

    const interval = setInterval(refetch, POLL_INTERVAL)
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refetch()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", onVisibilityChange) }
  }, [filter?.status, filter?.project, filter?.search, page, refetch])

  return { tasks, total, page, pageSize: PAGE_SIZE, setPage, loading, error, refetch }
}
