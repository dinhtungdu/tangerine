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
const SHOW_COMPLETED_KEY = "tangerine:sidebar-show-completed"
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

function readShowCompleted(): boolean {
  try {
    return localStorage.getItem(SHOW_COMPLETED_KEY) === "true"
  } catch {
    return false
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
  const [showCompleted, setShowCompleted] = useState(readShowCompleted)
  const [activePage, setActivePage] = useState(0)
  const [completedPage, setCompletedPage] = useState(0)

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  const activeTasks = useMemo(
    () => tasks.filter((t) => !TERMINATED_STATUSES.has(t.status) && t.type !== "orchestrator"),
    [tasks],
  )

  const completedTasks = useMemo(
    () => tasks.filter((t) => TERMINATED_STATUSES.has(t.status) && t.type !== "orchestrator"),
    [tasks],
  )

  const totalActivePages = Math.max(1, Math.ceil(activeTasks.length / ITEMS_PER_PAGE))
  const totalCompletedPages = Math.max(1, Math.ceil(completedTasks.length / ITEMS_PER_PAGE))
  const clampedActivePage = Math.min(activePage, totalActivePages - 1)
  const clampedCompletedPage = Math.min(completedPage, totalCompletedPages - 1)

  const pagedActiveTasks = activeTasks.slice(clampedActivePage * ITEMS_PER_PAGE, (clampedActivePage + 1) * ITEMS_PER_PAGE)
  const pagedCompletedTasks = completedTasks.slice(clampedCompletedPage * ITEMS_PER_PAGE, (clampedCompletedPage + 1) * ITEMS_PER_PAGE)

  // Reset pages when tasks change due to search
  useEffect(() => { setActivePage(0) }, [activeTasks.length])
  useEffect(() => { setCompletedPage(0) }, [completedTasks.length])

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

  const handleToggleCompleted = useCallback(() => {
    setShowCompleted((prev) => {
      const next = !prev
      try { localStorage.setItem(SHOW_COMPLETED_KEY, String(next)) } catch { /* ignore */ }
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
            <span className="text-md font-medium">New Agent</span>
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

      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-xxs font-medium tracking-wider text-fg-muted">ACTIVE RUNS</span>
        <div className="flex items-center justify-center rounded-sm bg-surface-dark px-2 py-0.5">
          <span className="font-mono text-xxs font-semibold text-white">{activeTasks.length}</span>
        </div>
      </div>

      <div className="h-px bg-edge" />

      <div className="flex-1 overflow-y-auto">
        {pagedActiveTasks.map((task) => (
          <TaskItem
            key={task.id}
            task={task}
            isActive={task.id === activeId}
            taskById={taskById}
            onRefetch={onRefetch}
          />
        ))}
        <PaginationControls
          page={clampedActivePage}
          totalPages={totalActivePages}
          onPrev={() => setActivePage((p) => Math.max(0, p - 1))}
          onNext={() => setActivePage((p) => Math.min(totalActivePages - 1, p + 1))}
        />

        {/* Completed toggle */}
        <div className="h-px bg-edge" />
        <button
          onClick={handleToggleCompleted}
          className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-surface-secondary"
        >
          <span className="text-xxs font-medium tracking-wider text-fg-muted">
            COMPLETED
          </span>
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-xxs text-fg-muted">{completedTasks.length}</span>
            <svg
              className={`h-3 w-3 text-fg-muted transition-transform ${showCompleted ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          </div>
        </button>
        <div className="h-px bg-edge" />

        {showCompleted && (
          <>
            {completedTasks.length === 0 ? (
              <div className="px-4 py-3 text-xs text-fg-muted">No completed tasks</div>
            ) : (
              pagedCompletedTasks.map((task) => (
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
              page={clampedCompletedPage}
              totalPages={totalCompletedPages}
              onPrev={() => setCompletedPage((p) => Math.max(0, p - 1))}
              onNext={() => setCompletedPage((p) => Math.min(totalCompletedPages - 1, p + 1))}
            />
          </>
        )}
      </div>
    </div>
  )
}
