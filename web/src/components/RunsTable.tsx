import { useState, useMemo } from "react"
import { Link } from "react-router-dom"
import type { Task, TaskStatus } from "@tangerine/shared"
import { getStatusConfig, hasUnseenUpdates } from "../lib/status"
import { formatDuration, formatPrNumber } from "../lib/format"
import { useProjectNav } from "../hooks/useProjectNav"
import { cancelTask, deleteTask, retryTask } from "../lib/api"
import { RunCard } from "./RunCard"

type StatusFilter = "all" | "running" | "done" | "failed" | "provisioning"

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "done", label: "Completed" },
  { key: "failed", label: "Failed" },
  { key: "provisioning", label: "Provisioning" },
]

function StatusBadge({ status }: { status: TaskStatus }) {
  const { label, textClass, bgClass } = getStatusConfig(status)
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold leading-tight ${textClass} ${bgClass}`}>
      {label}
    </span>
  )
}

function ParentLabel({ task, taskById }: { task: Task; taskById: Map<string, Task> }) {
  if (!task.parentTaskId) return null
  const parent = taskById.get(task.parentTaskId)
  if (!parent) return null
  return (
    <span className="truncate text-[11px] text-fg-muted">
      {task.type === "review" ? "Review of" : "Continued from"}: {parent.title}
    </span>
  )
}

function formatStartedAt(iso: string | null, created: string): string {
  const d = new Date(iso ?? created)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}

interface RunsTableProps {
  tasks: Task[]
  searchQuery: string
  onSearchChange: (q: string) => void
  onRefetch: () => void
}

const STATUS_FILTER_KEY = "runs-status-filter"

function readStoredFilter(): StatusFilter {
  try {
    const v = localStorage.getItem(STATUS_FILTER_KEY)
    if (v && STATUS_FILTERS.some((f) => f.key === v)) return v as StatusFilter
  } catch { /* ignore */ }
  return "all"
}

export function RunsTable({ tasks, searchQuery, onSearchChange, onRefetch }: RunsTableProps) {
  const { link } = useProjectNav()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(readStoredFilter)

  function handleFilterChange(key: StatusFilter) {
    setStatusFilter(key)
    try { localStorage.setItem(STATUS_FILTER_KEY, key) } catch { /* ignore */ }
  }

  const filtered = statusFilter === "all"
    ? tasks
    : tasks.filter((t) => t.status === statusFilter)

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  async function handleCancel(id: string) {
    try { await cancelTask(id); onRefetch() } catch { /* ignore */ }
  }

  async function handleRetry(id: string) {
    try { await retryTask(id); onRefetch() } catch { /* ignore */ }
  }

  async function handleDelete(id: string) {
    try { await deleteTask(id); onRefetch() } catch { /* ignore */ }
  }

  const isTerminated = (s: string) => ["done", "failed", "cancelled"].includes(s)
  const isRetryable = (s: string) => ["failed", "cancelled"].includes(s)

  return (
    <div className="flex flex-col gap-3 md:gap-4">
      {/* Filter + Search bar */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-2">
        <div className="flex gap-1.5 overflow-x-auto">
          {STATUS_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => handleFilterChange(key)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium md:rounded-md md:px-3.5 md:text-[13px] ${
                statusFilter === key
                  ? "bg-surface-dark text-white"
                  : "border border-edge bg-surface text-fg-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="md:flex-1" />
        <div className="flex h-9 items-center gap-2 rounded-lg border border-edge px-2.5 md:w-[220px]">
          <svg className="h-3.5 w-3.5 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search runs..."
            className="min-w-0 flex-1 bg-transparent text-[16px] text-fg placeholder-fg-muted outline-none md:text-[13px]"
          />
        </div>
      </div>

      {/* Desktop: table layout */}
      <div className="hidden overflow-hidden rounded-lg border border-edge md:block">
        {/* Header */}
        <div className="flex bg-surface-secondary text-[13px] text-fg-muted">
          <div className="flex-1 px-3 py-2.5">Run Name</div>
          <div className="w-[120px] px-3 py-2.5">Status</div>
          <div className="w-[100px] px-3 py-2.5">Duration</div>
          <div className="w-[100px] px-3 py-2.5">Source</div>
          <div className="w-[160px] px-3 py-2.5">Started</div>
          <div className="w-[70px] px-3 py-2.5 text-right">Actions</div>
        </div>
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-[13px] text-fg-muted">No runs found</div>
        ) : (
          filtered.map((task) => {
            const unseen = hasUnseenUpdates(task)
            return (
            <Link
              key={task.id}
              to={link(`/tasks/${task.id}`)}
              className="flex items-center border-t border-edge text-[13px] hover:bg-surface-secondary/50"
            >
              <div className="flex flex-1 flex-col gap-0.5 truncate px-3 py-2.5">
                <div className="flex items-center gap-2 font-medium text-fg">
                  {unseen && <span className="h-2 w-2 shrink-0 rounded-full bg-status-info" title="New activity" />}
                  <span className="truncate">{task.title}</span>
                  {task.prUrl && (
                    <a
                      href={task.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-700 hover:bg-green-500/20"
                    >
                      {formatPrNumber(task.prUrl)}
                    </a>
                  )}
                </div>
                <ParentLabel task={task} taskById={taskById} />
              </div>
              <div className="w-[120px] px-3 py-2.5"><StatusBadge status={task.status} /></div>
              <div className="w-[100px] px-3 py-2.5 text-fg-muted">{formatDuration(task.startedAt, task.completedAt, task.createdAt)}</div>
              <div className="w-[100px] px-3 py-2.5 text-fg-muted capitalize">{task.source}</div>
              <div className="w-[160px] px-3 py-2.5 text-fg-muted">{formatStartedAt(task.startedAt, task.createdAt)}</div>
              <div className="flex w-[70px] items-center justify-end px-2">
                {task.status === "running" && (
                  <button onClick={(e) => { e.preventDefault(); handleCancel(task.id) }} className="rounded p-1.5 hover:bg-surface-secondary" title="Cancel">
                    <svg className="h-4 w-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
                {isRetryable(task.status) && (
                  <button onClick={(e) => { e.preventDefault(); handleRetry(task.id) }} className="rounded p-1.5 hover:bg-surface-secondary" title="Retry">
                    <svg className="h-4 w-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
                    </svg>
                  </button>
                )}
                {isTerminated(task.status) && task.status !== "done" && (
                  <button onClick={(e) => { e.preventDefault(); handleDelete(task.id) }} className="rounded p-1.5 hover:bg-surface-secondary" title="Delete">
                    <svg className="h-4 w-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                    </svg>
                  </button>
                )}
              </div>
            </Link>
          )})
        )}
      </div>

      {/* Mobile: card layout */}
      <div className="flex flex-col gap-2.5 md:hidden">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-[13px] text-fg-muted">No runs found</div>
        ) : (
          filtered.map((task) => (
            <RunCard
              key={task.id}
              task={task}
              parentTask={task.parentTaskId ? taskById.get(task.parentTaskId) : undefined}
              onCancel={task.status === "running" ? handleCancel : undefined}
              onRetry={isRetryable(task.status) ? handleRetry : undefined}
              onDelete={isTerminated(task.status) && task.status !== "done" ? handleDelete : undefined}
            />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="text-[12px] text-fg-muted md:text-[13px]">
        Showing {filtered.length} of {tasks.length} runs
      </div>
    </div>
  )
}
