import type { TaskStatus } from "@tangerine/shared"

const statusConfig: Record<TaskStatus, { color: string; label: string; pulse?: boolean }> = {
  created: { color: "bg-amber-400", label: "Created" },
  provisioning: { color: "bg-amber-400", label: "Provisioning" },
  running: { color: "bg-green-500", label: "Running", pulse: true },
  done: { color: "bg-neutral-400", label: "Done" },
  failed: { color: "bg-red-500", label: "Failed" },
  cancelled: { color: "bg-neutral-400", label: "Cancelled" },
}

interface StatusBadgeProps {
  status: TaskStatus
  showLabel?: boolean
}

export function StatusBadge({ status, showLabel = true }: StatusBadgeProps) {
  const config = statusConfig[status]

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`h-2 w-2 rounded-full ${config.color} ${config.pulse ? "animate-status-pulse" : ""}`}
      />
      {showLabel && (
        <span className="text-xs text-[#737373]">{config.label}</span>
      )}
    </span>
  )
}
