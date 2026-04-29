import type { ReactNode } from "react"
import type { TaskStatus } from "@tangerine/shared"
import { MessageSquare, Terminal } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export type TaskViewMode = "chat" | "tui"

export function shouldSyncAgentTuiOnChatReturn(status: TaskStatus | null | undefined, suspended: boolean | null | undefined) {
  return status === "running" && !suspended
}

interface TaskViewModeToggleProps {
  value: TaskViewMode
  agentSessionId: string | null | undefined
  onChange: (mode: TaskViewMode) => void
}

export function TaskViewModeToggle({ value, agentSessionId, onChange }: TaskViewModeToggleProps) {
  if (!agentSessionId) return null

  return (
    <ToggleGroup
      aria-label="Task view"
      value={[value]}
      onValueChange={(next) => {
        const selected = next.at(-1)
        if (selected === "chat" || selected === "tui") onChange(selected)
      }}
      variant="outline"
      size="sm"
      spacing={0}
      className="bg-background"
    >
      <ToggleGroupItem value="chat" aria-label="Chat">
        <MessageSquare data-icon="inline-start" aria-hidden="true" />
        Chat
      </ToggleGroupItem>
      <ToggleGroupItem value="tui" aria-label="TUI">
        <Terminal data-icon="inline-start" aria-hidden="true" />
        TUI
      </ToggleGroupItem>
    </ToggleGroup>
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
