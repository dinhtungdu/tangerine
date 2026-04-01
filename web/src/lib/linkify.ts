import type { Task } from "@tangerine/shared"

export type TextPart =
  | { type: "text"; text: string }
  | { type: "url"; url: string }
  | { type: "taskRef"; taskId: string; display: string }

/**
 * Split text into typed parts: plain text, URLs, and task refs.
 * Used to render user/thinking/narration messages with clickable task links.
 *
 * Short refs (#abc1234 or task:abc1234) only match known tasks — prevents
 * false positives with git commit SHAs and other hex strings.
 */
export function splitTextParts(text: string, tasks: Task[]): TextPart[] {
  if (!text) return []

  const taskById = new Map(tasks.map((t) => [t.id.toLowerCase(), t]))
  const taskByShort = new Map(tasks.map((t) => [t.id.slice(0, 8), t]))

  // Single pass: URL | prefixed short ref | full UUID
  const combined = new RegExp(
    `(https?://[^\\s<>"]+|(?:#|task:)[0-9a-f]{8}\\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`,
    "gi",
  )

  const parts: TextPart[] = []
  let lastIndex = 0

  for (const match of text.matchAll(combined)) {
    const raw = match[1]
    const start = match.index!

    // Capture group is always present since the pattern is a single group
    if (raw === undefined) continue

    let resolved: TextPart | null = null

    if (/^https?:\/\//i.test(raw)) {
      resolved = { type: "url", url: raw }
    } else if (raw.startsWith("#") || /^task:/i.test(raw)) {
      const shortId = raw.replace(/^#|^task:/i, "").toLowerCase()
      const task = taskByShort.get(shortId)
      if (task) resolved = { type: "taskRef", taskId: task.id, display: `#${shortId}` }
    } else {
      // Full UUID — only linkify if it matches a known task
      const id = raw.toLowerCase()
      const task = taskById.get(id)
      if (task) resolved = { type: "taskRef", taskId: task.id, display: `#${id.slice(0, 8)}` }
    }

    // Unresolved match (e.g. unknown short ref): skip — absorbed into surrounding text
    if (resolved === null) continue

    if (start > lastIndex) {
      parts.push({ type: "text", text: text.slice(lastIndex, start) })
    }
    parts.push(resolved)
    lastIndex = start + raw.length
  }

  if (lastIndex < text.length) {
    parts.push({ type: "text", text: text.slice(lastIndex) })
  }

  return parts.length === 0 ? [{ type: "text", text }] : parts
}

/**
 * Pre-process markdown text to convert task refs into markdown links.
 * The ReactMarkdown `a` renderer then handles /tasks/ hrefs as router links.
 *
 * Single-pass replacement to avoid double-processing (e.g., a UUID inside an
 * already-inserted link href).
 *
 * Short refs only match known tasks; full UUIDs also only match known tasks.
 */
export function linkifyTaskRefsInMarkdown(text: string, tasks: Task[]): string {
  if (tasks.length === 0) return text

  const taskById = new Map(tasks.map((t) => [t.id.toLowerCase(), t]))
  const taskByShort = new Map(tasks.map((t) => [t.id.slice(0, 8), t]))

  const combined = new RegExp(
    `((?:#|task:)[0-9a-f]{8}\\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`,
    "gi",
  )

  return text.replace(combined, (match) => {
    let task: Task | undefined
    let shortId: string

    if (match.startsWith("#") || /^task:/i.test(match)) {
      shortId = match.replace(/^#|^task:/i, "").toLowerCase()
      task = taskByShort.get(shortId)
    } else {
      const id = match.toLowerCase()
      task = taskById.get(id)
      shortId = id.slice(0, 8)
    }

    if (!task) return match
    return `[#${shortId}](/tasks/${task.id})`
  })
}
