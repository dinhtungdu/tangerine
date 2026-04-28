import type { Task } from "@tangerine/shared"

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
  cancelled:    { label: "Cancelled",    textClass: "text-muted-foreground",    bgClass: "bg-muted",              color: "var(--color-muted-foreground)" },
  created:      { label: "Queued",       textClass: "text-status-warning-text", bgClass: "bg-status-warning-bg",  color: "var(--color-status-warning)" },
  provisioning: { label: "Provisioning", textClass: "text-status-warning-text", bgClass: "bg-status-warning-bg",  color: "var(--color-status-warning)" },
}

const DEFAULT_STATUS: StatusConfig = {
  label: "Unknown",
  textClass: "text-muted-foreground",
  bgClass: "bg-muted",
  color: "var(--color-muted-foreground)",
}

export function getStatusConfig(status: string): StatusConfig {
  return STATUS_CONFIG[status] ?? DEFAULT_STATUS
}

const IDLE_AGENT_STATUS: StatusConfig = {
  label: "Idle",
  textClass: "text-status-warning-text",
  bgClass: "bg-status-warning-bg",
  color: "var(--color-status-warning)",
}

export function getTaskDisplayStatus(task: Pick<Task, "status" | "agentStatus">): StatusConfig {
  if (task.status === "running" && task.agentStatus === "idle") return IDLE_AGENT_STATUS
  return getStatusConfig(task.status)
}

export function getTaskStatusText(task: Pick<Task, "status" | "agentStatus">): string {
  if (task.status === "running" && task.agentStatus === "idle") return "idle"
  return task.status
}

export const PR_STATUS_CONFIG: Record<string, StatusConfig> = {
  open:   { label: "Open",   textClass: "text-status-success-text", bgClass: "bg-status-success-bg", color: "var(--color-status-success)" },
  draft:  { label: "Draft",  textClass: "text-muted-foreground",    bgClass: "bg-muted",             color: "var(--color-muted-foreground)" },
  merged: { label: "Merged", textClass: "text-status-merged-text",  bgClass: "bg-status-merged-bg",  color: "var(--color-status-merged)" },
  closed: { label: "Closed", textClass: "text-status-error-text",   bgClass: "bg-status-error-bg",   color: "var(--color-status-error)" },
}

const UNKNOWN_PR_STATUS: StatusConfig = {
  label: "PR",
  textClass: "text-muted-foreground",
  bgClass: "bg-muted",
  color: "var(--color-muted-foreground)",
}

export function getPrStatusConfig(status: string | null): StatusConfig {
  if (!status) return UNKNOWN_PR_STATUS
  return PR_STATUS_CONFIG[status] ?? UNKNOWN_PR_STATUS
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
