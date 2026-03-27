import { useProject } from "../context/ProjectContext"
import { TerminalPane } from "../components/TerminalPane"

export function ProjectTerminalPage() {
  const { current } = useProject()

  if (!current) {
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        <p>Select a project to open its terminal.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-edge px-4 py-2">
        <div className="flex items-center gap-2">
          <svg className="h-4 w-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
          <span className="text-[13px] font-medium text-fg">
            {current.name} — repo terminal
          </span>
        </div>
        <span className="text-[11px] text-fg-muted">
          tmux: {current.name}-repo
        </span>
      </div>

      {/* Terminal */}
      <div className="min-h-0 flex-1">
        <TerminalPane wsPath={`/api/projects/${encodeURIComponent(current.name)}/terminal`} />
      </div>
    </div>
  )
}
