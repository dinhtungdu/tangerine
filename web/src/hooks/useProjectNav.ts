import { useCallback } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"

/** Build a path with the current ?project= param preserved. */
function withProject(path: string, project: string | null): string {
  if (!project) return path
  const sep = path.includes("?") ? "&" : "?"
  return `${path}${sep}project=${encodeURIComponent(project)}`
}

/** Navigation helpers that preserve the ?project= search param. */
export function useProjectNav() {
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
  const project = searchParams.get("project")

  const navigate = useCallback(
    (path: string) => nav(withProject(path, project)),
    [nav, project],
  )

  /** Build a `to` string for <Link> components. */
  const link = useCallback(
    (path: string) => withProject(path, project),
    [project],
  )

  return { navigate, link }
}
