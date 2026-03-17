import { Link, useNavigate } from "react-router-dom"
import { useProject } from "../context/ProjectContext"
import { useTaskSearch } from "../hooks/useTaskSearch"
import { TasksSidebar } from "../components/TasksSidebar"
import { NewAgentForm } from "../components/NewAgentForm"
import { ProjectSwitcher } from "../components/ProjectSwitcher"
import { createTask } from "../lib/api"
import { getStatusConfig } from "../lib/status"
import { formatDuration, formatDate } from "../lib/format"
import type { Task } from "@tangerine/shared"

/* ── Source icon ── */

function SourceIcon({ source }: { source: string }) {
  const cls = "h-[13px] w-[13px] text-[#737373]"
  if (source === "github") {
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0-12.814a2.25 2.25 0 1 0 0-2.186m0 2.186a2.25 2.25 0 1 0 0 2.186" />
      </svg>
    )
  }
  return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
    </svg>
  )
}

/* ── Run card ── */

function RunCard({ task }: { task: Task }) {
  const { label, color, bg } = getStatusConfig(task.status)

  return (
    <Link
      to={`/tasks/${task.id}`}
      className="rounded-[10px] border border-[#e5e5e5] p-3.5 transition active:bg-[#fafafa]"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[14px] font-medium text-[#0a0a0a]">{task.title}</span>
        <span
          className="shrink-0 rounded-xl px-2.5 py-0.5 text-[11px] font-semibold"
          style={{ color, backgroundColor: bg }}
        >
          {label}
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-4 text-[12px] text-[#737373]">
        <div className="flex items-center gap-1.5">
          <svg className="h-[13px] w-[13px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
          <span>{formatDuration(task.startedAt, task.completedAt, task.createdAt)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <SourceIcon source={task.source} />
          <span className="capitalize">{task.source === "github" ? "GitHub Push" : task.source}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <svg className="h-[13px] w-[13px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
          </svg>
          <span>{formatDate(task.createdAt)}</span>
        </div>
      </div>
    </Link>
  )
}

/* ── Dashboard page ── */

export function Dashboard() {
  const navigate = useNavigate()
  const { current } = useProject()
  const { query, setQuery, tasks, refetch } = useTaskSearch(current?.name)

  const handleNewAgent = async (data: { projectId: string; title: string; description?: string }) => {
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
        {/* Mobile topbar */}
        <div className="flex h-12 items-center justify-between border-b border-[#e5e5e5] px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#171717]">
              <svg className="h-3.5 w-3.5 text-[#fafafa]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 0 1-6.126 0l-.772-.13c-1.717-.293-2.3-2.379-1.067-3.61L13 15" />
              </svg>
            </div>
            <span className="text-[15px] font-bold text-[#0a0a0a]">Tangerine</span>
          </div>
          <div className="flex items-center gap-2">
            <button aria-label="Notifications" className="flex h-8 w-8 items-center justify-center rounded-md">
              <svg className="h-4 w-4 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
              </svg>
            </button>
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#171717]" aria-label="User avatar">
              <span className="text-[11px] font-semibold text-[#fafafa]">TN</span>
            </div>
          </div>
        </div>

        <ProjectSwitcher variant="mobile" />

        {/* Runs header */}
        <div className="flex flex-col gap-1 border-b border-[#e5e5e5] px-4 py-3">
          <h1 className="text-[18px] font-semibold text-[#0a0a0a]">Agent Runs</h1>
          <p className="text-[12px] text-[#737373]">Monitor and manage run history</p>
        </div>

        {/* Search + New */}
        <div className="flex items-center gap-2 px-4 py-2.5">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#e5e5e5] px-2.5">
            <svg className="h-4 w-4 shrink-0 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search runs..."
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[#0a0a0a] placeholder-[#737373] outline-none"
            />
          </div>
          <Link
            to="/new"
            className="flex h-9 items-center gap-1.5 rounded-lg bg-[#171717] px-3.5 text-white"
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
              <div className="py-16 text-center text-[13px] text-[#a3a3a3]">No runs yet</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
