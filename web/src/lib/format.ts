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

const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi

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

/** Replace full UUIDs matching known task IDs with markdown links.
 *  For pre-processing raw markdown before ReactMarkdown rendering.
 *  Skips fenced code blocks and inline code spans to avoid corrupting
 *  code examples that happen to contain task IDs. */
export function linkifyTaskIdsMarkdown(
  text: string,
  tasks: ReadonlyArray<{ id: string }>,
): string {
  if (tasks.length === 0) return text
  const known = new Map(tasks.map((t) => [t.id.toLowerCase(), t.id]))
  // Split on fenced code blocks (```...```) and inline code (`...`), leaving
  // code segments (odd indices from a capturing-group split) unchanged.
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g)
  return segments
    .map((seg, i) => {
      if (i % 2 === 1) return seg // code segment — leave as-is
      return seg.replace(UUID_RE, (uuid) => {
        const canonicalId = known.get(uuid.toLowerCase())
        if (!canonicalId) return uuid
        return `[${canonicalId.slice(0, 8)}](/tasks/${canonicalId})`
      })
    })
    .join("")
}

/** Extract PR number from a GitHub PR URL, e.g. "https://github.com/owner/repo/pull/123" → "#123" */
export function formatPrNumber(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)/)
  return match ? `#${match[1]}` : "PR"
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/** Convert a 5-field cron expression to a human-readable string.
 *  Handles common patterns; falls back to the raw expression for complex ones. */
export function formatCronExpression(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string]

  // Every minute
  if (minute === "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return "Every minute"
  }

  // Every N minutes
  const everyNMin = minute.match(/^\*\/(\d+)$/)
  if (everyNMin && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${everyNMin[1]} minutes`
  }

  // Every N hours
  const everyNHour = hour.match(/^\*\/(\d+)$/)
  if (minute !== "*" && everyNHour && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${everyNHour[1]} hours`
  }

  const formatTime = (h: string, m: string) => {
    const hr = parseInt(h, 10)
    const mn = parseInt(m, 10)
    const ampm = hr >= 12 ? "PM" : "AM"
    const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr
    return `${h12}:${mn.toString().padStart(2, "0")} ${ampm}`
  }

  // Specific time, every day
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dayOfMonth === "*" && month === "*") {
    const time = formatTime(hour, minute)
    if (dayOfWeek === "*") return `Daily at ${time}`
    if (dayOfWeek === "1-5") return `Weekdays at ${time}`
    if (dayOfWeek === "0,6") return `Weekends at ${time}`

    // Specific days
    const days = dayOfWeek.split(",").map((d) => DAY_NAMES[parseInt(d, 10)] ?? d).join(", ")
    return `${days} at ${time}`
  }

  return cron
}
