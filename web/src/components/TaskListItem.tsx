import { useState, useEffect, useRef } from "react"
import type { Task } from "@tangerine/shared"
import { executeAction } from "../lib/actions"

const TERMINATED_STATUSES = new Set(["done", "completed", "failed", "cancelled"])

export function TaskOverflowMenu({
  task,
  onRefetch,
  size = "sm",
}: {
  task: Task
  onRefetch?: () => void
  size?: "sm" | "md"
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const isRunning = task.status === "running"
  const isRetryable = task.status === "failed" || task.status === "cancelled"
  const isTerminated = TERMINATED_STATUSES.has(task.status)
  const isDeletable = isTerminated

  const hasActions = isRunning || isRetryable || isDeletable

  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onClickOutside)
    return () => document.removeEventListener("mousedown", onClickOutside)
  }, [open])

  if (!hasActions) return null

  async function handleAction(actionId: string) {
    try {
      await executeAction(actionId, { taskId: task.id })
      onRefetch?.()
    } catch {
      // ignore
    }
    setOpen(false)
  }

  const btnCls = size === "sm" ? "h-6 w-6" : "h-7 w-7"
  const iconCls = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"
  const topCls = size === "sm" ? "top-7" : "top-8"
  const itemCls = size === "sm"
    ? "px-3 py-1.5 text-xs"
    : "px-3 py-2 text-md"

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className={`flex items-center justify-center rounded hover:bg-edge ${btnCls}`}
        aria-label="Task actions"
      >
        <svg className={`${iconCls} text-fg-muted`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="6" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="12" cy="18" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && (
        <div className={`absolute right-0 ${topCls} z-50 min-w-[120px] rounded-md border border-edge bg-surface py-1 shadow-lg`}>
          {isRunning && (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleAction("task.cancel") }}
              className={`flex w-full items-center gap-2 text-left text-fg-muted hover:bg-surface-secondary hover:text-fg ${itemCls}`}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
              Cancel
            </button>
          )}
          {isRetryable && (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleAction("task.retry") }}
              className={`flex w-full items-center gap-2 text-left text-fg-muted hover:bg-surface-secondary hover:text-fg ${itemCls}`}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
              </svg>
              Retry
            </button>
          )}
          {isDeletable && (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleAction("task.delete") }}
              className={`flex w-full items-center gap-2 text-left text-status-error hover:bg-surface-secondary ${itemCls}`}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
              </svg>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  )
}

