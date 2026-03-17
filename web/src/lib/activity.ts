/** Shared activity/event helpers used by ActivityPanel and mobile activities */

export interface EventStyle {
  bg: string
  dot: string
}

export const EVENT_STYLES: Record<string, EventStyle> = {
  read:    { bg: "#3b82f620", dot: "#3b82f6" },
  write:   { bg: "#8b5cf620", dot: "#8b5cf6" },
  edit:    { bg: "#8b5cf620", dot: "#8b5cf6" },
  bash:    { bg: "#3b82f620", dot: "#3b82f6" },
  search:  { bg: "#f59e0b20", dot: "#f59e0b" },
  test:    { bg: "#22c55e20", dot: "#22c55e" },
  default: { bg: "#3b82f620", dot: "#3b82f6" },
}

export function getEventType(content: string): string {
  const lc = content.toLowerCase()
  if (lc.includes("read file") || lc.includes("file-search")) return "read"
  if (lc.includes("write file") || lc.includes("file-pen")) return "write"
  if (lc.includes("edit")) return "edit"
  if (lc.includes("bash") || lc.includes("terminal")) return "bash"
  if (lc.includes("search") || lc.includes("grep")) return "search"
  if (lc.includes("test")) return "test"
  return "default"
}

export function getEventStyle(content: string): EventStyle {
  const type = getEventType(content)
  return EVENT_STYLES[type] ?? EVENT_STYLES.default!
}
