import { useProject } from "../context/ProjectContext"
import { useTaskSearch } from "../hooks/useTaskSearch"
import { useProjectNav } from "../hooks/useProjectNav"
import { TasksSidebar } from "../components/TasksSidebar"
import { ActiveRunsCard, BuildLog, SystemLog, ProjectUpdateCard } from "../components/StatusWidgets"

export function StatusPage() {
  const { navigate } = useProjectNav()
  const { current } = useProject()
  const { query, setQuery, tasks } = useTaskSearch(current?.name)

  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <TasksSidebar tasks={tasks} searchQuery={query} onSearchChange={setQuery} onNewAgent={() => navigate("/")} />
      </div>

      {/* Main content */}
      <div className="flex h-full w-full flex-col">
        {/* Mobile header */}
        <div className="flex h-[52px] items-center gap-3 border-b border-edge px-4 md:hidden">
          <button onClick={() => navigate("/")} aria-label="Back" className="text-fg">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </button>
          <span className="text-[18px] font-semibold text-fg">Status</span>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6">
          <div className="flex flex-col gap-4 md:gap-6">
            {/* Title — desktop only */}
            <div className="hidden flex-col gap-1 md:flex">
              <h1 className="text-[24px] font-semibold text-fg">System Status</h1>
              <p className="text-[14px] text-fg-muted">Infrastructure health for the current project</p>
            </div>

            {/* Project update */}
            <ProjectUpdateCard project={current?.name} />

            {/* Active runs card */}
            <ActiveRunsCard tasks={tasks} />

            {/* Build log */}
            <BuildLog project={current?.name} buildStatus={{ status: "idle" }} />

            {/* System log */}
            <SystemLog project={current?.name} />
          </div>
        </div>
      </div>
    </div>
  )
}
