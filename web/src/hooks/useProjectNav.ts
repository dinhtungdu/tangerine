import { useCallback } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"

/** Build a path with the current ?project= param preserved. */
function withProject(path: string, project: string | null): string {
  if (!project) return path
  // Split off hash if present — hash must come after query string
  const hashIdx = path.indexOf("#")
  const hash = hashIdx >= 0 ? path.slice(hashIdx) : ""
  const pathWithoutHash = hashIdx >= 0 ? path.slice(0, hashIdx) : path
  const sep = pathWithoutHash.includes("?") ? "&" : "?"
  return `${pathWithoutHash}${sep}project=${encodeURIComponent(project)}${hash}`
}

/** Navigation helpers that preserve the ?project= search param. */
export function useProjectNav() {
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
  const project = searchParams.get("project")

  const navigate = useCallback(
    (path: string, options?: { state?: unknown }) => nav(withProject(path, project), options),
    [nav, project],
  )

  /** Build a `to` string for <Link> components. */
  const link = useCallback(
    (path: string) => withProject(path, project),
    [project],
  )

  return { navigate, link }
}
