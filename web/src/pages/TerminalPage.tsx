import { useProject } from "../context/ProjectContext"
import { TerminalPane } from "../components/TerminalPane"

export function TerminalPage() {
  const { current } = useProject()

  if (!current) {
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        No project selected
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <TerminalPane wsUrl={`/api/projects/${encodeURIComponent(current.name)}/terminal`} />
      </div>
    </div>
  )
}
