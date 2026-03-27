/** Unified status configuration — uses Tailwind class names for theming */

export interface StatusConfig {
  label: string
  /** Tailwind text color class */
  textClass: string
  /** Tailwind bg color class */
  bgClass: string
  /** Raw color for inline style fallbacks (e.g. status dots) */
  color: string
}

export const STATUS_CONFIG: Record<string, StatusConfig> = {
  running:      { label: "Running",      textClass: "text-status-success-text", bgClass: "bg-status-success-bg", color: "var(--color-status-success)" },
  done:         { label: "Completed",    textClass: "text-status-info-text", bgClass: "bg-status-info-bg",  color: "var(--color-status-info)" },
  failed:       { label: "Failed",       textClass: "text-status-error-text",   bgClass: "bg-status-error-bg",    color: "var(--color-status-error)" },
  cancelled:    { label: "Cancelled",    textClass: "text-fg-muted",            bgClass: "bg-surface-secondary",  color: "var(--color-fg-muted)" },
  created:      { label: "Queued",       textClass: "text-status-warning-text", bgClass: "bg-status-warning-bg",  color: "var(--color-status-warning)" },
  provisioning: { label: "Provisioning", textClass: "text-status-warning-text", bgClass: "bg-status-warning-bg",  color: "var(--color-status-warning)" },
}

const DEFAULT_STATUS: StatusConfig = {
  label: "Unknown",
  textClass: "text-fg-muted",
  bgClass: "bg-surface-secondary",
  color: "var(--color-fg-muted)",
}

export function getStatusConfig(status: string): StatusConfig {
  return STATUS_CONFIG[status] ?? DEFAULT_STATUS
}

/** Returns true if the agent has produced a result since the user last viewed the task */
export function hasUnseenUpdates(task: { lastResultAt: string | null; lastSeenAt: string | null; status: string }): boolean {
  // Only show for active tasks — completed/cancelled tasks don't need attention
  if (task.status === "done" || task.status === "cancelled") return false
  // Tasks still in initial states haven't produced agent output yet
  if (task.status === "created" || task.status === "provisioning") return false
  // No result yet — nothing to show
  if (!task.lastResultAt) return false
  // Never viewed — unseen if agent has produced a result
  if (!task.lastSeenAt) return true
  return new Date(task.lastResultAt) > new Date(task.lastSeenAt)
}
