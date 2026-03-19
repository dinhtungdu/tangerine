import { Link } from "react-router-dom"
import type { Task } from "@tangerine/shared"
import { getStatusConfig } from "../lib/status"
import { formatDuration, formatDate } from "../lib/format"

function SourceIcon({ source }: { source: string }) {
  const cls = "h-[13px] w-[13px] text-fg-muted"
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

export function RunCard({ task }: { task: Task }) {
  const { label, textClass, bgClass } = getStatusConfig(task.status)

  return (
    <Link
      to={`/tasks/${task.id}`}
      className="rounded-[10px] border border-edge p-3.5 transition active:bg-surface"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[14px] font-medium text-fg">{task.title}</span>
        <span
          className={`shrink-0 rounded-xl px-2.5 py-0.5 text-[11px] font-semibold ${textClass} ${bgClass}`}
        >
          {label}
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-4 text-[12px] text-fg-muted">
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
        <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
          {task.provider === "claude-code" ? "Claude Code" : "OpenCode"}
        </span>
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
