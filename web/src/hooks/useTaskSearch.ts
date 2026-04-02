import { useState, useMemo, useDeferredValue } from "react"
import type { Task } from "@tangerine/shared"
import { useTasks } from "./useTasks"

/** Extract raw PR number string from a PR URL for searching, e.g. "#123" or "123" */
function extractPrNumber(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)/)
  return match ? `#${match[1]}` : ""
}

interface UseTaskSearchResult {
  query: string
  setQuery: (q: string) => void
  tasks: Task[]
  loading: boolean
  refetch: () => void
}

export function useTaskSearch(project?: string): UseTaskSearchResult {
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)

  // Only hit the server when we have a query — otherwise fetch all
  const serverSearch = deferredQuery.length >= 2 ? deferredQuery : undefined
  const { tasks: allTasks, loading, refetch } = useTasks(
    project ? { project, search: serverSearch } : { search: serverSearch }
  )

  // Client-side filter on top of whatever the server returned
  const tasks = useMemo(() => {
    if (!deferredQuery) return allTasks
    const lower = deferredQuery.toLowerCase()
    return allTasks.filter(
      (t) =>
        t.title.toLowerCase().includes(lower) ||
        (t.description?.toLowerCase().includes(lower) ?? false) ||
        (t.branch?.toLowerCase().includes(lower) ?? false) ||
        (t.prUrl !== null && extractPrNumber(t.prUrl).includes(lower))
    )
  }, [allTasks, deferredQuery])

  return { query, setQuery, tasks, loading, refetch }
}
