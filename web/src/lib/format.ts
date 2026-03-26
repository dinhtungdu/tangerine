/** Strip date suffix (e.g. "anthropic/claude-sonnet-4-20250514" -> "anthropic/claude-sonnet-4") */
export function formatModelName(model: string): string {
  return model.replace(/-\d{8}$/, "")
}

/** "2m 05s", "1h 30m" */
export function formatDuration(startIso: string | null, endIso: string | null, createdIso: string): string {
  const start = startIso ? new Date(startIso).getTime() : new Date(createdIso).getTime()
  const end = endIso ? new Date(endIso).getTime() : Date.now()
  const diff = end - start
  const mins = Math.floor(diff / 60000)
  const secs = Math.floor((diff % 60000) / 1000)
  if (mins >= 60) {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return `${h}h ${m}m`
  }
  return `${mins}m ${secs.toString().padStart(2, "0")}s`
}

/** "Mar 18" */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/** "just now", "5m ago", "3h ago", "2d ago" */
export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** "14:32:01" */
export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

/** Extract PR number from a GitHub PR URL, e.g. "https://github.com/owner/repo/pull/123" → "#123" */
export function formatPrNumber(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)/)
  return match ? `#${match[1]}` : "PR"
}
