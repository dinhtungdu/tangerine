import { Link, useNavigate } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { useTaskSearch } from "../hooks/useTaskSearch"
import { TasksSidebar } from "../components/TasksSidebar"
import { NewAgentForm } from "../components/NewAgentForm"
import { ProjectSwitcher } from "../components/ProjectSwitcher"
import { RunCard } from "../components/RunCard"
import { createTask } from "../lib/api"

/* ── Dashboard page ── */

export function Dashboard() {
  const navigate = useNavigate()
  const { current } = useProject()
  const { query, setQuery, tasks, refetch } = useTaskSearch(current?.name)

  const handleNewAgent = async (data: { projectId: string; title: string; description?: string; provider?: string }) => {
    try {
      const task = await createTask(data)
      refetch()
      navigate(`/tasks/${task.id}`)
    } catch {
      // TODO: show error toast
    }
  }

  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <TasksSidebar tasks={tasks} searchQuery={query} onSearchChange={setQuery} onNewAgent={() => {}} />
      </div>

      {/* Desktop: new agent form */}
      <div className="hidden flex-1 md:flex">
        <NewAgentForm onSubmit={handleNewAgent} />
      </div>

      {/* Mobile: runs list */}
      <div className="flex h-full w-full flex-col md:hidden">
        {/* Project switcher — topbar is in Layout */}
        <ProjectSwitcher variant="mobile" />

        {/* Runs header */}
        <div className="flex flex-col gap-1 border-b border-edge px-4 py-3">
          <h1 className="text-[18px] font-semibold text-fg">Agent Runs</h1>
          <p className="text-[12px] text-fg-muted">Monitor and manage run history</p>
        </div>

        {/* Search + New */}
        <div className="flex items-center gap-2 px-4 py-2.5">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-edge px-2.5">
            <svg className="h-4 w-4 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search runs..."
              className="min-w-0 flex-1 bg-transparent text-[13px] text-fg placeholder-fg-muted outline-none"
            />
          </div>
          <Link
            to="/new"
            className="flex h-9 items-center gap-1.5 rounded-lg bg-surface-dark px-3.5 text-white"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span className="text-[13px] font-medium">Run</span>
          </Link>
        </div>

        {/* Run cards */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 pt-1">
          <div className="flex flex-col gap-2.5">
            {tasks.map((task) => (
              <RunCard key={task.id} task={task} />
            ))}
            {tasks.length === 0 && (
              <div className="py-16 text-center text-[13px] text-fg-faint">No runs yet</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
