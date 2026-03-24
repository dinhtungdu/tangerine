import { useProject } from "../context/ProjectContext"
import { useTaskSearch } from "../hooks/useTaskSearch"
import { useProjectNav } from "../hooks/useProjectNav"
import { ProjectSwitcher } from "../components/ProjectSwitcher"
import { RunsTable } from "../components/RunsTable"

export function RunsPage() {
  const { navigate } = useProjectNav()
  const { current } = useProject()
  const { query, setQuery, tasks, refetch } = useTaskSearch(current?.name)

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Mobile project switcher */}
      <div className="md:hidden">
        <ProjectSwitcher variant="mobile" />
      </div>

      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-8">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-bold text-fg md:text-[24px]">Agent Runs</h1>
            <p className="mt-0.5 text-[13px] text-fg-muted">Monitor and manage your agent run history</p>
          </div>
          <button
            onClick={() => navigate("/new")}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-surface-dark px-4 text-white md:h-10 md:px-5"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span className="text-[13px] font-medium md:text-[14px]">New Run</span>
          </button>
        </div>

        {/* Runs table — responsive */}
        <RunsTable
          tasks={tasks}
          searchQuery={query}
          onSearchChange={setQuery}
          onRefetch={refetch}
        />
      </div>
    </div>
  )
}
