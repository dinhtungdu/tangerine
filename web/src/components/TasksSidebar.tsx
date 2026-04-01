import { useMemo, useState, useCallback, useEffect } from "react"
import { Link, useLocation, useParams } from "react-router-dom"
import type { Task } from "@tangerine/shared"
import { getStatusConfig, hasUnseenUpdates } from "../lib/status"
import { formatRelativeTime } from "../lib/format"
import { useProjectNav } from "../hooks/useProjectNav"
import { useProject } from "../context/ProjectContext"
import { ensureOrchestrator } from "../lib/api"
import { TaskOverflowMenu } from "./TaskListItem"

interface TasksSidebarProps {
  tasks: Task[]
  searchQuery: string
  onSearchChange: (query: string) => void
  onNewAgent: () => void
  onRefetch?: () => void
}

const TERMINATED_STATUSES = new Set(["done", "completed", "failed", "cancelled"])
const ACTIVE_ONLY_KEY = "tangerine:sidebar-active-only"
const ITEMS_PER_PAGE = 20

function PaginationControls({ page, totalPages, onPrev, onNext }: { page: number; totalPages: number; onPrev: () => void; onNext: () => void }) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-between px-4 py-1.5">
      <button
        onClick={onPrev}
        disabled={page === 0}
        className="rounded px-2 py-0.5 text-xxs text-fg-muted hover:bg-surface-secondary disabled:opacity-30"
      >
        ← Prev
      </button>
      <span className="font-mono text-xxs text-fg-muted">{page + 1} / {totalPages}</span>
      <button
        onClick={onNext}
        disabled={page === totalPages - 1}
        className="rounded px-2 py-0.5 text-xxs text-fg-muted hover:bg-surface-secondary disabled:opacity-30"
      >
        Next →
      </button>
    </div>
  )
}

function readActiveOnly(): boolean {
  try {
    const v = localStorage.getItem(ACTIVE_ONLY_KEY)
    if (v !== null) return v !== "false"
    // Migrate from old key: show-completed=true → activeOnly=false
    const old = localStorage.getItem("tangerine:sidebar-show-completed")
    if (old === "true") return false
    return true
  } catch {
    return true
  }
}

function ParentLabel({ task, taskById }: { task: Task; taskById: Map<string, Task> }) {
  if (!task.parentTaskId) return null
  const parent = taskById.get(task.parentTaskId)
  if (!parent) return null
  return (
    <span className="truncate text-2xs text-fg-muted">
      Continued from: {parent.title}
    </span>
  )
}

function TaskItem({
  task,
  isActive,
  taskById,
  onRefetch,
}: {
  task: Task
  isActive: boolean
  taskById: Map<string, Task>
  onRefetch?: () => void
}) {
  const { link } = useProjectNav()
  const { color } = getStatusConfig(task.status)
  const unseen = !isActive && hasUnseenUpdates(task)

  return (
    <Link
      to={link(`/tasks/${task.id}`)}
      className={`group flex items-start gap-2.5 px-4 py-2.5 ${
        isActive
          ? "bg-surface-secondary border-l-[3px] border-l-status-error"
          : "hover:bg-surface-secondary"
      }`}
      style={isActive ? {} : { borderLeft: "3px solid transparent" }}
    >
      <div className="flex h-[18px] w-2 items-start pt-[5px]">
        <div className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className={`truncate text-md text-fg ${isActive ? "font-semibold" : "font-medium"}`}>
            {task.title}
          </span>
          {unseen && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-status-info" title="New activity" />
          )}
        </div>
        <span className="font-mono text-xxs text-fg-muted">
          {formatRelativeTime(task.createdAt)} · {task.status}
          {" · "}
          <span className="rounded bg-surface-secondary px-1 py-px text-2xs">
            {task.provider === "claude-code" ? "CC" : task.provider === "codex" ? "CX" : "OC"}
          </span>
          {task.type !== "worker" && (
            <>
              {" · "}
              <span className="rounded bg-surface-secondary px-1 py-px text-2xs">
                {task.type}
              </span>
            </>
          )}
        </span>
        <ParentLabel task={task} taskById={taskById} />
      </div>
      <div className="shrink-0 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100">
        <TaskOverflowMenu task={task} onRefetch={onRefetch} size="sm" />
      </div>
    </Link>
  )
}

export function TasksSidebar({ tasks, searchQuery, onSearchChange, onNewAgent, onRefetch }: TasksSidebarProps) {
  const { id: activeId } = useParams<{ id: string }>()
  const location = useLocation()
  const isRoot = location.pathname === "/"
  const { navigate } = useProjectNav()
  const { current: project } = useProject()
  const [orchLoading, setOrchLoading] = useState(false)
  const [activeOnly, setActiveOnly] = useState(readActiveOnly)
  const [page, setPage] = useState(0)

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  // Single sorted list: active first, then completed — search always shows all statuses
  const isSearching = searchQuery.length > 0
  const sortedTasks = useMemo(() => {
    const nonOrch = tasks.filter((t) => t.type !== "orchestrator")
    if (activeOnly && !isSearching) return nonOrch.filter((t) => !TERMINATED_STATUSES.has(t.status))
    // Active tasks first, then completed — stable within each group (API order)
    const active: Task[] = []
    const completed: Task[] = []
    for (const t of nonOrch) {
      if (TERMINATED_STATUSES.has(t.status)) completed.push(t)
      else active.push(t)
    }
    return [...active, ...completed]
  }, [tasks, activeOnly, isSearching])

  const activeCount = useMemo(
    () => tasks.filter((t) => !TERMINATED_STATUSES.has(t.status) && t.type !== "orchestrator").length,
    [tasks],
  )

  const totalPages = Math.max(1, Math.ceil(sortedTasks.length / ITEMS_PER_PAGE))
  const clampedPage = Math.min(page, totalPages - 1)
  const pagedTasks = sortedTasks.slice(clampedPage * ITEMS_PER_PAGE, (clampedPage + 1) * ITEMS_PER_PAGE)

  useEffect(() => { setPage(0) }, [searchQuery, activeOnly])

  const orchestrator = useMemo(() => {
    const orchTasks = tasks.filter((t) => t.type === "orchestrator")
    return orchTasks.find((t) => !TERMINATED_STATUSES.has(t.status)) ?? null
  }, [tasks])

  const handleOrchestratorClick = useCallback(async () => {
    if (!project) return
    if (orchestrator) {
      navigate(`/tasks/${orchestrator.id}`)
      return
    }
    setOrchLoading(true)
    try {
      const task = await ensureOrchestrator(project.name)
      navigate(`/tasks/${task.id}`)
    } finally {
      setOrchLoading(false)
    }
  }, [project, orchestrator, navigate])

  const handleToggleActiveOnly = useCallback(() => {
    setActiveOnly((prev) => {
      const next = !prev
      try { localStorage.setItem(ACTIVE_ONLY_KEY, String(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  return (
    <div className="flex h-full w-full shrink-0 flex-col border-r border-edge bg-surface md:w-[240px]">
      {/* Top section */}
      <div className="flex flex-col gap-3 p-4 pt-5">
        {!isRoot && (
          <button
            onClick={onNewAgent}
            className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-surface-dark text-white"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span className="text-md font-medium">New Run</span>
          </button>
        )}
        <div className="flex h-[34px] items-center gap-2 rounded-md border border-edge bg-surface px-2.5">
          <svg className="h-3.5 w-3.5 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search tasks..."
            className="min-w-0 flex-1 bg-transparent text-base text-fg placeholder-fg-muted outline-none md:text-md"
          />
          {searchQuery && (
            <button onClick={() => onSearchChange("")} aria-label="Clear search" className="shrink-0 text-fg-muted hover:text-fg">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Orchestrator entry — pinned above active runs */}
      <button
        onClick={handleOrchestratorClick}
        disabled={orchLoading}
        className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left ${
          orchestrator?.id === activeId
            ? "bg-surface-secondary border-l-[3px] border-l-status-error"
            : "hover:bg-surface-secondary"
        }`}
        style={orchestrator?.id === activeId ? {} : { borderLeft: "3px solid transparent" }}
      >
        <div className="flex h-[18px] w-2 items-center">
          {orchLoading ? (
            <div className="h-2 w-2 animate-spin rounded-full border border-fg-muted border-t-transparent" />
          ) : (
            <div
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: orchestrator ? getStatusConfig(orchestrator.status).color : "var(--color-fg-muted)" }}
            />
          )}
        </div>
        <span className="text-md font-medium text-fg">Orchestrator</span>
      </button>

      <div className="h-px bg-edge" />

      <button
        onClick={handleToggleActiveOnly}
        className="flex w-full shrink-0 items-center justify-between px-4 py-2.5 text-left hover:bg-surface-secondary"
      >
        <span className="text-xxs font-medium tracking-wider text-fg-muted">
          {activeOnly && !isSearching ? "ACTIVE RUNS" : "ALL RUNS"}
        </span>
        <div className="flex items-center justify-center rounded-sm bg-surface-dark px-2 py-0.5">
          <span className="font-mono text-xxs font-semibold text-white">
            {activeOnly && !isSearching ? activeCount : sortedTasks.length}
          </span>
        </div>
      </button>

      <div className="h-px bg-edge" />

      <div className="md:flex-1 md:min-h-0 md:overflow-y-auto">
        {pagedTasks.length === 0 ? (
          <div className="px-4 py-3 text-xs text-fg-muted">No tasks</div>
        ) : (
          pagedTasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              isActive={task.id === activeId}
              taskById={taskById}
              onRefetch={onRefetch}
            />
          ))
        )}
        <PaginationControls
          page={clampedPage}
          totalPages={totalPages}
          onPrev={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
        />
      </div>
    </div>
  )
}
