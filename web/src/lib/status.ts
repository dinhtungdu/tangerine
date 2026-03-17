/** Unified status configuration used across sidebar, dashboard, and task detail */

export interface StatusConfig {
  label: string
  /** Dot/text color */
  color: string
  /** Badge background color */
  bg: string
}

export const STATUS_CONFIG: Record<string, StatusConfig> = {
  running:      { label: "Running",      color: "#16a34a", bg: "#dcfce7" },
  done:         { label: "Completed",    color: "#737373", bg: "#f5f5f5" },
  completed:    { label: "Completed",    color: "#737373", bg: "#f5f5f5" },
  failed:       { label: "Failed",       color: "#dc2626", bg: "#fecaca" },
  cancelled:    { label: "Cancelled",    color: "#737373", bg: "#f5f5f5" },
  created:      { label: "Queued",       color: "#a16207", bg: "#fef9c3" },
  provisioning: { label: "Provisioning", color: "#a16207", bg: "#fef9c3" },
}

const DEFAULT_STATUS: StatusConfig = { label: "Unknown", color: "#737373", bg: "#f5f5f5" }

export function getStatusConfig(status: string): StatusConfig {
  return STATUS_CONFIG[status] ?? DEFAULT_STATUS
}
