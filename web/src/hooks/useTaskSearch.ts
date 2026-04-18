import { useState, useDeferredValue } from "react"
import type { Task } from "@tangerine/shared"
import { useTasks } from "./useTasks"

interface UseTaskSearchResult {
  query: string
  setQuery: (q: string) => void
  tasks: Task[]
  total: number
  page: number
  pageSize: number
  setPage: (page: number) => void
  loading: boolean
  refetch: () => void
}

export function useTaskSearch(project?: string): UseTaskSearchResult {
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)

  // Always send search to server for consistent pagination behavior
  const serverSearch = deferredQuery || undefined
  const { tasks, total, page, pageSize, setPage, loading, refetch } = useTasks(
    project ? { project, search: serverSearch } : { search: serverSearch }
  )

  return { query, setQuery, tasks, total, page, pageSize, setPage, loading, refetch }
}
