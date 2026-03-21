import { useState } from "react"
import { Link } from "react-router-dom"
import type { Task, TaskStatus } from "@tangerine/shared"
import { getStatusConfig } from "../lib/status"
import { formatDuration } from "../lib/format"
import { cancelTask, deleteTask } from "../lib/api"

type StatusFilter = "all" | "running" | "done" | "failed" | "created"

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "done", label: "Success" },
  { key: "failed", label: "Failed" },
  { key: "created", label: "Queued" },
]

interface RunsTableProps {
  tasks: Task[]
  searchQuery: string
  onSearchChange: (q: string) => void
  onRefetch: () => void
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const colors: Record<string, { bg: string; text: string }> = {
    running:      { bg: "bg-blue-500",    text: "text-white" },
    done:         { bg: "bg-green-500",   text: "text-white" },
    completed:    { bg: "bg-green-500",   text: "text-white" },
    failed:       { bg: "bg-red-500",     text: "text-white" },
    cancelled:    { bg: "bg-neutral-400", text: "text-white" },
    created:      { bg: "bg-amber-500",   text: "text-white" },
    provisioning: { bg: "bg-amber-500",   text: "text-white" },
  }
  const { label } = getStatusConfig(status)
  const c = colors[status] ?? { bg: "bg-neutral-400", text: "text-white" }
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[12px] font-semibold leading-tight ${c.bg} ${c.text}`}>
      {label}
    </span>
  )
}

function formatStartedAt(iso: string | null, created: string): string {
  const d = new Date(iso ?? created)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}

function SourceLabel({ source }: { source: string }) {
  if (source === "github") return <>GitHub Push</>
  if (source === "linear") return <>Linear</>
  return <>Manual</>
}

export function RunsTable({ tasks, searchQuery, onSearchChange, onRefetch }: RunsTableProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

  const filtered = statusFilter === "all"
    ? tasks
    : tasks.filter((t) => t.status === statusFilter)

  async function handleCancel(id: string) {
    try { await cancelTask(id); onRefetch() } catch { /* ignore */ }
  }

  async function handleDelete(id: string) {
    try { await deleteTask(id); onRefetch() } catch { /* ignore */ }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filter bar */}
      <div className="flex items-center gap-2">
        {STATUS_FILTERS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`rounded-md px-3.5 py-1.5 text-[13px] font-medium ${
              statusFilter === key
                ? "bg-neutral-900 text-neutral-50"
                : "bg-neutral-50 text-neutral-900 border border-neutral-200"
            }`}
          >
            {label}
          </button>
        ))}
        <div className="flex-1" />
        <div className="flex h-7 w-[200px] items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-2.5">
          <svg className="h-3.5 w-3.5 shrink-0 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search runs..."
            className="min-w-0 flex-1 bg-transparent text-[16px] text-fg placeholder-neutral-500 outline-none md:text-[13px]"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-neutral-200">
        {/* Header */}
        <div className="flex bg-neutral-100 text-[14px] text-neutral-500">
          <div className="flex-1 px-3 py-3">Run Name</div>
          <div className="w-[140px] px-3 py-3">Status</div>
          <div className="w-[120px] px-3 py-3">Duration</div>
          <div className="w-[160px] px-3 py-3">Triggered By</div>
          <div className="w-[180px] px-3 py-3">Started At</div>
          <div className="w-[80px] px-3 py-3 text-right">Actions</div>
        </div>

        {/* Rows */}
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-[13px] text-neutral-400">
            No runs found
          </div>
        ) : (
          filtered.map((task) => (
            <Link
              key={task.id}
              to={`/tasks/${task.id}`}
              className="flex items-center border-t border-neutral-200 text-[14px] hover:bg-neutral-50"
            >
              <div className="flex-1 truncate px-3 py-3 font-medium text-neutral-900">
                {task.title}
              </div>
              <div className="w-[140px] px-3 py-3">
                <StatusBadge status={task.status} />
              </div>
              <div className="w-[120px] px-3 py-3 text-neutral-900">
                {formatDuration(task.startedAt, task.completedAt, task.createdAt)}
              </div>
              <div className="w-[160px] px-3 py-3 text-neutral-900">
                <SourceLabel source={task.source} />
              </div>
              <div className="w-[180px] px-3 py-3 text-neutral-500">
                {formatStartedAt(task.startedAt, task.createdAt)}
              </div>
              <div className="flex w-[80px] items-center justify-end gap-0.5 px-2 py-1">
                {task.status === "running" && (
                  <button
                    onClick={(e) => { e.preventDefault(); handleCancel(task.id) }}
                    className="rounded-md p-2 hover:bg-neutral-100"
                    title="Cancel"
                  >
                    <svg className="h-4 w-4 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
                {task.status !== "running" && task.status !== "provisioning" && (
                  <button
                    onClick={(e) => { e.preventDefault(); handleDelete(task.id) }}
                    className="rounded-md p-2 hover:bg-neutral-100"
                    title="Delete"
                  >
                    <svg className="h-4 w-4 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                    </svg>
                  </button>
                )}
              </div>
            </Link>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="text-[14px] text-neutral-500">
        Showing {filtered.length} records
      </div>
    </div>
  )
}
