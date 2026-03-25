import { useState, useEffect } from "react"
import { fetchDiff, type DiffFile } from "../lib/api"

export function useDiffFiles(taskId: string) {
  const [files, setFiles] = useState<DiffFile[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setFiles([])
    setLoading(true)
  }, [taskId])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await fetchDiff(taskId)
        if (!cancelled) setFiles(data.files ?? [])
      } catch { /* no diff */ }
      finally { if (!cancelled) setLoading(false) }
    }
    load()
    const interval = setInterval(load, 15000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [taskId])

  return { files, loading }
}
