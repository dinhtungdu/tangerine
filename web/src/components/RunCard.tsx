import { Link } from "react-router-dom"
import type { Task } from "@tangerine/shared"
import { getStatusConfig, hasUnseenUpdates } from "../lib/status"
import { formatDuration, formatDate, formatPrNumber } from "../lib/format"
import { useProject } from "../context/ProjectContext"
import { buildSshEditorUri, EDITOR_NAMES } from "../lib/ssh-editor"

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

interface RunCardProps {
  task: Task
  parentTask?: Task
  onCancel?: (id: string) => void
  onRetry?: (id: string) => void
  onDelete?: (id: string) => void
}

export function RunCard({ task, parentTask, onCancel, onRetry, onDelete }: RunCardProps) {
  const { label, textClass, bgClass } = getStatusConfig(task.status)
  const isTerminated = ["done", "failed", "cancelled"].includes(task.status)
  const unseen = hasUnseenUpdates(task)
  const { sshHost, sshUser, editor } = useProject()
  // Zed requires a username; suppress the link when sshUser is absent for Zed
  const sshEditorUri = (sshHost && editor && task.worktreePath && (editor !== "zed" || sshUser))
    ? buildSshEditorUri(editor, sshHost, task.worktreePath, sshUser)
    : null

  return (
    <Link
      to={`/tasks/${task.id}`}
      className="rounded-[10px] border border-edge p-3.5 transition active:bg-surface"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {unseen && <span className="h-2 w-2 shrink-0 rounded-full bg-status-info" title="New activity" />}
          <span className="truncate text-[14px] font-medium text-fg">{task.title}</span>
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-700"
            >
              {formatPrNumber(task.prUrl)}
            </a>
          )}
        </div>
        <span
          className={`shrink-0 rounded-xl px-2.5 py-0.5 text-[11px] font-semibold ${textClass} ${bgClass}`}
        >
          {label}
        </span>
      </div>
      {parentTask && (
        <div className="mt-1.5 truncate text-[12px] text-fg-muted">
          Continued from: {parentTask.title}
        </div>
      )}
      {task.status === "failed" && task.error && (
        <div className="mt-1.5 truncate text-[12px] text-status-error" title={task.error}>
          {task.error}
        </div>
      )}
      <div className="mt-2.5 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-fg-muted">
          <div className="flex items-center gap-1.5">
            <svg className="h-[13px] w-[13px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
            <span>{formatDuration(task.startedAt, task.completedAt, task.createdAt)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <SourceIcon source={task.source} />
            <span className="capitalize">{task.source === "github" ? "GitHub" : task.source}</span>
          </div>
          <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] font-medium text-fg-muted">
            {task.provider === "claude-code" ? "Claude" : task.provider === "codex" ? "Codex" : "OpenCode"}
          </span>
          <div className="flex items-center gap-1.5">
            <svg className="h-[13px] w-[13px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
            </svg>
            <span>{formatDate(task.createdAt)}</span>
          </div>
          {sshEditorUri && editor && (
            // Use a button to avoid nesting <a> inside the card's outer <Link> anchor,
            // which would cause undefined navigation behavior across browsers.
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = sshEditorUri }}
              title={`Open in ${EDITOR_NAMES[editor]}`}
              className="flex items-center gap-1 text-fg-muted hover:text-fg"
            >
              <svg className="h-[13px] w-[13px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
              </svg>
              <span>{EDITOR_NAMES[editor]}</span>
            </button>
          )}
        </div>
        {/* Actions */}
        {(onCancel || onRetry || onDelete) && (task.status === "running" || isTerminated) && (
          <div className="flex shrink-0 items-center gap-1 pt-1">
            {task.status === "running" && onCancel && (
              <button
                onClick={(e) => { e.preventDefault(); onCancel(task.id) }}
                className="flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-fg-muted active:bg-surface-secondary"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
                <span className="text-[11px]">Cancel</span>
              </button>
            )}
            {onRetry && (
              <button
                onClick={(e) => { e.preventDefault(); onRetry(task.id) }}
                className="flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-fg-muted active:bg-surface-secondary"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
                </svg>
                <span className="text-[11px]">Retry</span>
              </button>
            )}
            {isTerminated && onDelete && (
              <button
                onClick={(e) => { e.preventDefault(); onDelete(task.id) }}
                className="flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-fg-muted active:bg-surface-secondary"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                </svg>
                <span className="text-[11px]">Delete</span>
              </button>
            )}
          </div>
        )}
      </div>
    </Link>
  )
}
