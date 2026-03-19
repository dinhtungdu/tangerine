import { Link, useParams } from "react-router-dom"
import type { Task } from "@tangerine/shared"
import { getStatusConfig } from "../lib/status"
import { formatRelativeTime } from "../lib/format"

interface TasksSidebarProps {
  tasks: Task[]
  searchQuery: string
  onSearchChange: (query: string) => void
  onNewAgent: () => void
}

export function TasksSidebar({ tasks, searchQuery, onSearchChange, onNewAgent }: TasksSidebarProps) {
  const { id: activeId } = useParams<{ id: string }>()

  return (
    <div className="flex h-full w-[260px] shrink-0 flex-col border-r border-edge bg-surface">
      {/* Top section */}
      <div className="flex flex-col gap-3 p-4 pt-5">
        <button
          onClick={onNewAgent}
          className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-black text-white"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="text-[13px] font-medium">New Agent</span>
        </button>
        <div className="flex h-[34px] items-center gap-2 rounded-md border border-edge bg-surface px-2.5">
          <svg className="h-3.5 w-3.5 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search tasks..."
            className="min-w-0 flex-1 bg-transparent text-[16px] text-fg placeholder-fg-muted outline-none md:text-[13px]"
          />
          {searchQuery && (
            <button onClick={() => onSearchChange("")} aria-label="Clear search" className="shrink-0 text-fg-muted hover:text-neutral-600">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="h-px bg-edge" />

      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-[11px] font-medium tracking-wider text-fg-muted">ALL RUNS</span>
        <div className="flex items-center justify-center rounded-sm bg-black px-2 py-0.5">
          <span className="font-mono text-[11px] font-semibold text-white">{tasks.length}</span>
        </div>
      </div>

      <div className="h-px bg-edge" />

      <div className="flex-1 overflow-y-auto">
        {tasks.map((task) => {
          const isActive = task.id === activeId
          const { color } = getStatusConfig(task.status)
          return (
            <Link
              key={task.id}
              to={`/tasks/${task.id}`}
              className={`flex gap-2.5 px-4 py-2.5 ${
                isActive
                  ? "bg-surface-secondary border-l-[3px] border-l-red-600"
                  : "hover:bg-surface-secondary"
              }`}
              style={isActive ? {} : { borderLeft: "3px solid transparent" }}
            >
              <div className="flex h-[18px] w-2 items-start pt-[5px]">
                <div className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className={`truncate text-[13px] text-black ${isActive ? "font-semibold" : "font-medium"}`}>
                  {task.title}
                </span>
                <span className="font-mono text-[11px] text-fg-muted">
                  {formatRelativeTime(task.createdAt)} · {task.status}
                  {" · "}
                  <span className="rounded bg-surface-secondary px-1 py-px text-[10px]">
                    {task.provider === "claude-code" ? "CC" : "OC"}
                  </span>
                </span>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
