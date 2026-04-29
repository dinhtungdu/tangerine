import type { ActivityEntry } from "@tangerine/shared"
import type { ChatMessage } from "../hooks/useSession"
import { getActivityDetail, getActivityStyle, resolveToolInput } from "./activity"

export type TimelineItem =
  | { kind: "message"; data: ChatMessage }
  | { kind: "tool"; data: ActivityEntry }

export interface TimelineGroup {
  id: string
  items: TimelineItem[]
  startTime: string
  endTime: string
  toolCount: number
  filesChanged: number
  errorCount: number
  hasToolsOrThinking: boolean
}

export interface ToolSegmentSummary {
  startTime: string
  endTime: string
  toolCount: number
  filesChanged: number
  errorCount: number
}

export type TimelineRenderSegment =
  | { kind: "message"; item: Extract<TimelineItem, { kind: "message" }>; index: number }
  | { kind: "tool"; item: Extract<TimelineItem, { kind: "tool" }>; index: number }
  | {
    kind: "tool-segment"
    items: Array<Extract<TimelineItem, { kind: "tool" }> & { index: number }>
    summary: ToolSegmentSummary
  }

export type ToolDisplayStatus = "running" | "success" | "error"

export function isToolActivity(activity: ActivityEntry): boolean {
  return activity.event.startsWith("tool.")
}

function activityStatus(activity: ActivityEntry): string | undefined {
  return (activity.metadata as { status?: string } | null)?.status
}

function isWriteOrEditActivity(activity: ActivityEntry): boolean {
  const meta = activity.metadata as { toolName?: string } | null
  const toolName = (meta?.toolName || activity.event.replace("tool.", "")).toLowerCase()
  return toolName.includes("write") || toolName.includes("edit")
}

function getFilePathFromActivity(activity: ActivityEntry): string | null {
  const meta = activity.metadata as Record<string, unknown> | null
  const input = resolveToolInput(meta?.toolInput)
  return (input?.file_path as string | undefined) || (input?.path as string | undefined) || null
}

export function summarizeToolSegment(items: ReadonlyArray<{ data: ActivityEntry }>): ToolSegmentSummary {
  const changedFiles = new Set<string>()
  let errorCount = 0

  for (const item of items) {
    if (isWriteOrEditActivity(item.data)) {
      const path = getFilePathFromActivity(item.data)
      if (path) changedFiles.add(path)
    }
    if (activityStatus(item.data) === "error") errorCount++
  }

  const first = items[0]
  const last = items[items.length - 1]
  const fallback = new Date().toISOString()
  return {
    startTime: first?.data.timestamp || fallback,
    endTime: last?.data.timestamp || first?.data.timestamp || fallback,
    toolCount: items.length,
    filesChanged: changedFiles.size,
    errorCount,
  }
}

export function mergeMessagesAndActivities(
  messages: ChatMessage[],
  activities: ActivityEntry[],
): TimelineItem[] {
  const merged: TimelineItem[] = []
  const messageItems: TimelineItem[] = messages.map((message) => ({ kind: "message", data: message }))
  const activityItems: TimelineItem[] = activities
    .filter(isToolActivity)
    .map((activity) => ({ kind: "tool", data: activity }))

  let messageIndex = 0
  let activityIndex = 0

  while (messageIndex < messageItems.length || activityIndex < activityItems.length) {
    const messageTime = messageIndex < messageItems.length
      ? new Date(messageItems[messageIndex]!.data.timestamp).getTime()
      : Infinity
    const activityTime = activityIndex < activityItems.length
      ? new Date(activityItems[activityIndex]!.data.timestamp).getTime()
      : Infinity

    if (messageTime <= activityTime) {
      merged.push(messageItems[messageIndex]!)
      messageIndex++
    } else {
      merged.push(activityItems[activityIndex]!)
      activityIndex++
    }
  }

  return merged
}

export function groupTimelineItems(items: TimelineItem[]): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  let currentGroup: TimelineItem[] = []
  let groupStartTime = ""

  const flushGroup = () => {
    if (currentGroup.length === 0) return

    const summary = summarizeToolSegment(currentGroup.filter((item) => item.kind === "tool"))
    const toolCount = currentGroup.filter((item) => item.kind === "tool").length
    const hasThinking = currentGroup.some((item) => item.kind === "message" && item.data.role === "thinking")
    const firstItem = currentGroup[0]!
    const lastItem = currentGroup[currentGroup.length - 1]!
    const id = firstItem.kind === "message" ? `msg-${firstItem.data.id}` : `activity-${firstItem.data.id}`

    groups.push({
      id,
      items: currentGroup,
      startTime: groupStartTime,
      endTime: lastItem.data.timestamp,
      toolCount,
      filesChanged: summary.filesChanged,
      errorCount: summary.errorCount,
      hasToolsOrThinking: toolCount > 0 || hasThinking,
    })
    currentGroup = []
    groupStartTime = ""
  }

  for (const item of items) {
    if (item.kind === "message" && item.data.role === "user") {
      flushGroup()
      groups.push({
        id: `msg-${item.data.id}`,
        items: [item],
        startTime: item.data.timestamp,
        endTime: item.data.timestamp,
        toolCount: 0,
        filesChanged: 0,
        errorCount: 0,
        hasToolsOrThinking: false,
      })
    } else {
      if (currentGroup.length === 0) groupStartTime = item.data.timestamp
      currentGroup.push(item)
    }
  }

  flushGroup()
  return groups
}

export function deriveChatTimelineGroups({
  messages,
  activities,
}: {
  messages: ChatMessage[]
  activities: ActivityEntry[]
}): TimelineGroup[] {
  return groupTimelineItems(mergeMessagesAndActivities(messages, activities))
}

export function splitToolSegments(items: TimelineItem[]): TimelineRenderSegment[] {
  const segments: TimelineRenderSegment[] = []
  let toolSegment: Array<Extract<TimelineItem, { kind: "tool" }> & { index: number }> = []

  const flushToolSegment = () => {
    if (toolSegment.length === 0) return
    const segment = toolSegment
    toolSegment = []

    if (segment.length < 2) {
      for (const item of segment) segments.push({ kind: "tool", item, index: item.index })
      return
    }

    segments.push({
      kind: "tool-segment",
      items: segment,
      summary: summarizeToolSegment(segment),
    })
  }

  items.forEach((item, index) => {
    if (item.kind === "tool") {
      toolSegment.push({ ...item, index })
      return
    }

    flushToolSegment()
    segments.push({ kind: "message", item, index })
  })
  flushToolSegment()

  return segments
}

export function getLastToolIndex(items: TimelineItem[]): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index]!.kind === "tool") return index
  }
  return -1
}

export function buildToolContent(activity: ActivityEntry): string {
  const meta = activity.metadata as Record<string, unknown> | null
  const toolName = meta?.toolName || activity.event.replace("tool.", "")
  const input = resolveToolInput(meta?.toolInput)
  return JSON.stringify({
    tool: toolName,
    name: toolName,
    input,
    ...meta,
  })
}

export function deriveToolStatus(
  activity: ActivityEntry,
  { isStreaming, isLastTool }: { isStreaming: boolean; isLastTool: boolean },
): ToolDisplayStatus {
  const status = activityStatus(activity)
  if (status === "error") return "error"
  if (isStreaming && isLastTool && status === "running") return "running"
  return "success"
}

export function deriveStreamingStatusLabel(group: TimelineGroup): string {
  for (let index = group.items.length - 1; index >= 0; index--) {
    const item = group.items[index]!
    if (item.kind === "tool") {
      const meta = item.data.metadata
      const label = (meta?.toolName as string | undefined) || getActivityStyle(item.data.event).label || item.data.event.replace("tool.", "")
      const detail = getActivityDetail(item.data.event, item.data.content, meta)
      return detail && detail !== item.data.content ? `${label} · ${detail}` : label
    }

    if (item.data.role === "thinking") return "Thinking"
    if (item.data.role === "assistant" && item.data.content.trim().length > 0) return "Writing response"
  }

  return "Agent is working..."
}
