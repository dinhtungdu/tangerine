import { TERMINAL_STATUSES } from "@tangerine/shared"
import type { Task } from "@tangerine/shared"
import { MoreVertical, X, RefreshCw, Trash2, RotateCcw } from "lucide-react"
import { executeAction } from "../lib/actions"
import { useToast } from "../context/ToastContext"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function TaskOverflowMenu({
  task,
  onRefetch,
  size = "sm",
}: {
  task: Task
  onRefetch?: () => void
  size?: "sm" | "md"
}) {
  const { showToast } = useToast()

  const isRunning = task.status === "running"
  const isRetryable = task.status === "failed" || task.status === "cancelled"
  const isTerminated = TERMINAL_STATUSES.has(task.status)
  const isDeletable = isTerminated

  const hasActions = isRunning || isRetryable || isDeletable

  if (!hasActions) return null

  async function handleAction(actionId: string, errorMessage: string) {
    try {
      await executeAction(actionId, { taskId: task.id })
      onRefetch?.()
    } catch {
      showToast(errorMessage)
    }
  }

  const btnCls = size === "sm" ? "h-6 w-6" : "h-7 w-7"
  const iconCls = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"
  const itemCls = size === "sm"
    ? "px-3 py-1.5 text-xs"
    : "px-3 py-2 text-sm"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`flex items-center justify-center rounded hover:bg-border ${btnCls}`}
        aria-label="Task actions"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <MoreVertical className={`${iconCls} text-muted-foreground`} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[120px]">
        {isRunning && (
          <DropdownMenuItem
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleAction("task.restart", "Failed to restart task") }}
            className={`flex items-center gap-2 text-muted-foreground hover:text-foreground ${itemCls}`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Restart
          </DropdownMenuItem>
        )}
        {isRunning && (
          <DropdownMenuItem
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleAction("task.cancel", "Failed to cancel task") }}
            className={`flex items-center gap-2 text-muted-foreground hover:text-foreground ${itemCls}`}
          >
            <X className="h-3.5 w-3.5" />
            Cancel
          </DropdownMenuItem>
        )}
        {isRetryable && (
          <DropdownMenuItem
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleAction("task.retry", "Failed to retry task") }}
            className={`flex items-center gap-2 text-muted-foreground hover:text-foreground ${itemCls}`}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </DropdownMenuItem>
        )}
        {isDeletable && (
          <DropdownMenuItem
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleAction("task.delete", "Failed to delete task") }}
            className={`flex items-center gap-2 text-status-error ${itemCls}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
