import type { ReactNode } from "react"
import type { TaskStatus } from "@tangerine/shared"
import { MessageSquare, Terminal } from "lucide-react"
import { cn } from "@/lib/utils"

export type TaskViewMode = "chat" | "tui"

export function shouldSyncAgentTuiOnChatReturn(
  status: TaskStatus | null | undefined,
  suspended: boolean | null | undefined,
  wasTuiActive = true,
  tuiTaskId?: string | null,
  currentTaskId?: string | null,
  agentSessionId?: string | null,
) {
  if (status !== "running" || suspended || !wasTuiActive) return false
  if (agentSessionId !== undefined && !agentSessionId) return false
  if ((tuiTaskId !== undefined || currentTaskId !== undefined) && (!tuiTaskId || !currentTaskId || tuiTaskId !== currentTaskId)) return false
  return true
}

export function shouldTrackAgentTuiForTask(viewMode: TaskViewMode, taskId: string | null | undefined, currentTaskId: string | null | undefined) {
  return viewMode === "tui" && Boolean(taskId && currentTaskId && taskId === currentTaskId)
}

interface TaskViewModeToggleProps {
  value: TaskViewMode
  agentSessionId: string | null | undefined
  onChange: (mode: TaskViewMode) => void
}

export function TaskViewModeToggle({ value, agentSessionId, onChange }: TaskViewModeToggleProps) {
  if (!agentSessionId) return null

  return (
    <div
      aria-label="Task view"
      role="group"
      className="inline-flex rounded-[min(var(--radius-md),12px)] border border-border bg-background"
    >
      <button
        type="button"
        aria-label="Chat"
        aria-pressed={value === "chat"}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-l-[min(var(--radius-md),12px)] px-2 text-[0.8rem] font-medium transition-colors outline-none focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-ring/50",
          value === "chat" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        onClick={() => onChange("chat")}
      >
        <MessageSquare className="size-3.5" aria-hidden="true" />
        Chat
      </button>
      <button
        type="button"
        aria-label="TUI"
        aria-pressed={value === "tui"}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-r-[min(var(--radius-md),12px)] border-l border-border px-2 text-[0.8rem] font-medium transition-colors outline-none focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-ring/50",
          value === "tui" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        onClick={() => onChange("tui")}
      >
        <Terminal className="size-3.5" aria-hidden="true" />
        TUI
      </button>
    </div>
  )
}

export function TaskChatSurface({
  viewMode,
  agentSessionId,
  terminal,
  children,
}: {
  viewMode: TaskViewMode
  agentSessionId: string | null | undefined
  terminal: ReactNode
  children: ReactNode
}) {
  if (viewMode === "tui" && agentSessionId) {
    return <>{terminal}</>
  }

  return <>{children}</>
}
