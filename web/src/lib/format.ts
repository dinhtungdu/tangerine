import type { Task } from "@tangerine/shared"

/** Display-friendly task title. */
export function formatTaskTitle(task: Pick<Task, "title" | "type" | "projectId">): string {
  return task.title
}

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

/** "Mar 18 · 14:32:01" */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  const time = d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
  return `${date} · ${time}`
}

// Match UUIDs at word boundaries but skip those adjacent to "/" to avoid
// linkifying IDs inside URL paths like /api/tasks/<uuid> or <uuid>/logs
const UUID_RE = /(?<!\/)\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b(?!\/)/gi

/** Replace full UUIDs matching known task IDs with short HTML anchor tags.
 *  Input must already be HTML-escaped. Only UUIDs present in tasks are linked;
 *  unknown UUIDs are left as plain text to avoid false links.
 *  Always uses the canonical task ID from the tasks array in the href, so
 *  mixed-case matches in text still produce a valid navigation URL. */
export function linkifyTaskIds(
  html: string,
  tasks: ReadonlyArray<{ id: string }>,
): string {
  if (tasks.length === 0) return html
  // Map lowercase → canonical ID so href always uses the stored casing
  const known = new Map(tasks.map((t) => [t.id.toLowerCase(), t.id]))
  return html.replace(UUID_RE, (uuid) => {
    const canonicalId = known.get(uuid.toLowerCase())
    if (!canonicalId) return uuid
    return `<a href="/tasks/${canonicalId}" class="underline text-link hover:text-link-hover">${canonicalId.slice(0, 8)}</a>`
  })
}


/** Format a token count for compact display: 0 → "", 1500 → "1.5K", 1200000 → "1.2M" */
export function formatTokens(tokens: number): string {
  if (tokens <= 0) return ""
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}K`
  return String(tokens)
}

/** Extract PR number from a GitHub PR URL, e.g. "https://github.com/owner/repo/pull/123" → "#123" */
export function formatPrNumber(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)/)
  return match ? `#${match[1]}` : "PR"
}
