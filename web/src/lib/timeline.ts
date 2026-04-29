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
}

export type TimelineRenderSegment =
  | { kind: "message"; item: Extract<TimelineItem, { kind: "message" }>; index: number }
  | { kind: "tool"; item: Extract<TimelineItem, { kind: "tool" }>; index: number }

export type ToolDisplayStatus = "running" | "success" | "error"

export function isToolActivity(activity: ActivityEntry): boolean {
  return activity.event.startsWith("tool.")
}

function activityStatus(activity: ActivityEntry): string | undefined {
  return (activity.metadata as { status?: string } | null)?.status
}

interface OrderedTimelineItem {
  item: TimelineItem
  order: number
  kindRank: number
}

function timelineTimestampMs(item: TimelineItem): number {
  const parsed = Date.parse(item.data.timestamp)
  return Number.isFinite(parsed) ? parsed : 0
}

export function mergeMessagesAndActivities(
  messages: ChatMessage[],
  activities: ActivityEntry[],
): TimelineItem[] {
  const orderedItems: OrderedTimelineItem[] = [
    ...messages.map((message, order) => ({ item: { kind: "message" as const, data: message }, order, kindRank: 0 })),
    ...activities
      .filter(isToolActivity)
      .map((activity, order) => ({ item: { kind: "tool" as const, data: activity }, order, kindRank: 1 })),
  ]

  return orderedItems
    .sort((a, b) => timelineTimestampMs(a.item) - timelineTimestampMs(b.item) || a.kindRank - b.kindRank || a.order - b.order)
    .map(({ item }) => item)
}

export function groupTimelineItems(items: TimelineItem[]): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  let currentGroup: TimelineItem[] = []
  let groupStartTime = ""

  const flushGroup = () => {
    if (currentGroup.length === 0) return

    const firstItem = currentGroup[0]!
    const lastItem = currentGroup[currentGroup.length - 1]!
    const id = firstItem.kind === "message" ? `msg-${firstItem.data.id}` : `activity-${firstItem.data.id}`

    groups.push({
      id,
      items: currentGroup,
      startTime: groupStartTime,
      endTime: lastItem.data.timestamp,
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

export function splitTimelineItems(items: TimelineItem[]): TimelineRenderSegment[] {
  return items.map((item, index) => {
    if (item.kind === "tool") return { kind: "tool", item, index }
    return { kind: "message", item, index }
  })
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
