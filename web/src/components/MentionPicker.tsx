import type { Task } from "@tangerine/shared"
import { getTaskDisplayStatus } from "../lib/status"
import { formatTaskTitle } from "../lib/format"
import { SuggestionPicker } from "./SuggestionPicker"

interface MentionPickerProps {
  tasks: Task[]
  selectedIndex: number
  onSelect: (task: Task) => void
  onHover: (index: number) => void
}

export function MentionPicker({ tasks, selectedIndex, onSelect, onHover }: MentionPickerProps) {
  return (
    <SuggestionPicker
      items={tasks}
      selectedIndex={selectedIndex}
      getKey={(task) => task.id}
      onSelect={onSelect}
      onHover={onHover}
    >
      {(task) => {
        const statusConfig = getTaskDisplayStatus(task)
        return (
          <>
            <div
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: statusConfig.color }}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {formatTaskTitle(task)}
            </span>
            <span className="shrink-0 font-mono text-xxs text-muted-foreground">
              {task.id.slice(0, 8)}
            </span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium ${statusConfig.bgClass} ${statusConfig.textClass}`}
            >
              {statusConfig.label}
            </span>
          </>
        )
      }}
    </SuggestionPicker>
  )
}
