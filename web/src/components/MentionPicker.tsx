import type { Task } from "@tangerine/shared"
import { getStatusConfig } from "../lib/status"

interface MentionPickerProps {
  tasks: Task[]
  selectedIndex: number
  onSelect: (task: Task) => void
  onHover: (index: number) => void
  /** Rect of the textarea, used to position the dropdown */
  anchorRect: DOMRect | null
}

export function MentionPicker({ tasks, selectedIndex, onSelect, onHover, anchorRect }: MentionPickerProps) {
  if (tasks.length === 0 || !anchorRect) return null

  return (
    <div
      className="absolute bottom-full left-0 right-0 z-50 mb-1"
    >
      <div className="max-h-52 overflow-y-auto rounded-lg border border-edge bg-surface shadow-lg">
        {tasks.map((task, i) => {
          const statusConfig = getStatusConfig(task.status)
          const isSelected = i === selectedIndex
          return (
            <button
              key={task.id}
              onMouseDown={(e) => {
                e.preventDefault() // prevent blur
                onSelect(task)
              }}
              onMouseMove={() => onHover(i)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                isSelected ? "bg-surface-secondary" : ""
              }`}
            >
              <div
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: statusConfig.color }}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-fg">
                {task.title}
              </span>
              <span className="shrink-0 font-mono text-xxs text-fg-muted">
                {task.id.slice(0, 8)}
              </span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium ${statusConfig.bgClass} ${statusConfig.textClass}`}
              >
                {statusConfig.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
