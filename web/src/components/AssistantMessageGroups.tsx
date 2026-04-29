import { memo, useState, useCallback, useMemo, type ReactNode } from "react"
import type { ActivityEntry } from "@tangerine/shared"
import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { ChatMessage } from "./ChatMessage"
import { ToolCallDisplay } from "./ToolCallDisplay"
import { ToolCallsSummaryBar } from "./ToolCallsSummaryBar"
import { resolveToolInput } from "../lib/activity"

interface AssistantMessageGroupsProps {
  messages: ChatMessageType[]
  activities: ActivityEntry[]
  tasks?: ReadonlyArray<{ id: string }>
  onReply?: (content: string) => void
  isLastGroupStreaming: boolean
}

type MergedItem =
  | { kind: "message"; data: ChatMessageType }
  | { kind: "tool"; data: ActivityEntry }

interface MessageGroup {
  id: string
  items: MergedItem[]
  startTime: string
  endTime: string
  toolCount: number
  filesChanged: number
  errorCount: number
  hasToolsOrThinking: boolean
}

interface ToolSegmentSummary {
  startTime: string
  endTime: string
  toolCount: number
  filesChanged: number
  errorCount: number
}

function isToolActivity(activity: ActivityEntry): boolean {
  return activity.event.startsWith("tool.")
}

function isWriteOrEditActivity(activity: ActivityEntry): boolean {
  const meta = activity.metadata as { toolName?: string } | null
  const toolName = (meta?.toolName || "").toLowerCase()
  return toolName.includes("write") || toolName.includes("edit")
}

function getFilePathFromActivity(activity: ActivityEntry): string | null {
  const meta = activity.metadata as Record<string, unknown> | null
  const input = resolveToolInput(meta?.toolInput)
  return (input?.file_path as string | undefined) || (input?.path as string | undefined) || null
}

function summarizeToolSegment(items: ReadonlyArray<{ kind: "tool"; data: ActivityEntry }>): ToolSegmentSummary {
  const changedFiles = new Set<string>()
  let errorCount = 0

  for (const item of items) {
    if (isWriteOrEditActivity(item.data)) {
      const path = getFilePathFromActivity(item.data)
      if (path) changedFiles.add(path)
    }
    const meta = item.data.metadata as { status?: string } | null
    if (meta?.status === "error") errorCount++
  }

  const first = items[0]
  const last = items[items.length - 1]
  return {
    startTime: first?.data.timestamp || new Date().toISOString(),
    endTime: last?.data.timestamp || first?.data.timestamp || new Date().toISOString(),
    toolCount: items.length,
    filesChanged: changedFiles.size,
    errorCount,
  }
}

function mergeMessagesAndActivities(
  messages: ChatMessageType[],
  activities: ActivityEntry[]
): MergedItem[] {
  const merged: MergedItem[] = []

  const messageItems: MergedItem[] = messages.map((m) => ({ kind: "message" as const, data: m }))
  const toolActivities = activities.filter(isToolActivity)
  const activityItems: MergedItem[] = toolActivities.map((a) => ({ kind: "tool" as const, data: a }))

  let mi = 0
  let ai = 0

  while (mi < messageItems.length || ai < activityItems.length) {
    const msgTime = mi < messageItems.length ? new Date(messageItems[mi]!.data.timestamp).getTime() : Infinity
    const actTime = ai < activityItems.length ? new Date(activityItems[ai]!.data.timestamp).getTime() : Infinity

    if (msgTime <= actTime) {
      merged.push(messageItems[mi]!)
      mi++
    } else {
      merged.push(activityItems[ai]!)
      ai++
    }
  }

  return merged
}

function groupItems(items: MergedItem[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  let currentGroup: MergedItem[] = []
  let groupStartTime = ""

  const flushGroup = () => {
    if (currentGroup.length === 0) return

    let toolCount = 0
    const changedFiles = new Set<string>()
    let errorCount = 0
    let hasToolsOrThinking = false

    for (const item of currentGroup) {
      if (item.kind === "tool") {
        toolCount++
        hasToolsOrThinking = true
        if (isWriteOrEditActivity(item.data)) {
          const path = getFilePathFromActivity(item.data)
          if (path) changedFiles.add(path)
        }
        const meta = item.data.metadata as { status?: string } | null
        if (meta?.status === "error") errorCount++
      } else if (item.data.role === "thinking") {
        hasToolsOrThinking = true
      }
    }

    const firstItem = currentGroup[0]!
    const lastItem = currentGroup[currentGroup.length - 1]!
    const id = firstItem.kind === "message" ? `msg-${firstItem.data.id}` : `activity-${firstItem.data.id}`
    const endTime = lastItem.kind === "message" ? lastItem.data.timestamp : lastItem.data.timestamp

    groups.push({
      id,
      items: currentGroup,
      startTime: groupStartTime,
      endTime,
      toolCount,
      filesChanged: changedFiles.size,
      errorCount,
      hasToolsOrThinking,
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
      if (currentGroup.length === 0) {
        groupStartTime = item.kind === "message" ? item.data.timestamp : item.data.timestamp
      }
      currentGroup.push(item)
    }
  }
  flushGroup()

  return groups
}

function buildToolContent(activity: ActivityEntry): string {
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

function deriveToolStatus(
  activity: ActivityEntry,
  isStreaming: boolean,
  isLastTool: boolean
): "running" | "success" | "error" {
  const meta = activity.metadata as { status?: string } | null
  if (meta?.status === "error") return "error"
  // Only show "running" if this is the last tool in a streaming turn
  if (isStreaming && isLastTool && meta?.status === "running") return "running"
  return "success"
}

function AssistantGroup({
  group,
  tasks,
  onReply,
  isStreaming,
}: {
  group: MessageGroup
  tasks?: ReadonlyArray<{ id: string }>
  onReply?: (content: string) => void
  isStreaming: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  const handleToggle = useCallback(() => {
    setExpanded((v) => !v)
  }, [])

  const lastToolIdx = useMemo(() => {
    for (let i = group.items.length - 1; i >= 0; i--) {
      if (group.items[i]!.kind === "tool") return i
    }
    return -1
  }, [group.items])

  const renderedItems: ReactNode[] = []
  let toolSegment: Array<{ kind: "tool"; data: ActivityEntry; index: number }> = []

  const flushToolSegment = () => {
    if (toolSegment.length === 0) return
    const segment = toolSegment
    toolSegment = []

    if (segment.length < 2) {
      for (const item of segment) {
        const status = deriveToolStatus(item.data, isStreaming, item.index === lastToolIdx)
        renderedItems.push(
          <div key={`tool-${item.data.id}`} className="pb-6">
            <ToolCallDisplay content={buildToolContent(item.data)} status={status} />
          </div>
        )
      }
      return
    }

    const summary = summarizeToolSegment(segment)
    renderedItems.push(
      <div key={`tools-${segment[0]!.data.id}`} className="pb-6 flex flex-col gap-3">
        <ToolCallsSummaryBar
          isStreaming={isStreaming}
          startTime={summary.startTime}
          endTime={summary.endTime}
          toolCount={summary.toolCount}
          filesChanged={summary.filesChanged}
          errorCount={summary.errorCount}
          expanded={expanded}
          onToggle={handleToggle}
        />
        {expanded && (
          <div className="flex flex-col gap-4 pl-2 border-l-2 border-border">
            {segment.map((item) => {
              const status = deriveToolStatus(item.data, isStreaming, item.index === lastToolIdx)
              return (
                <ToolCallDisplay
                  key={`tool-${item.data.id}`}
                  content={buildToolContent(item.data)}
                  status={status}
                />
              )
            })}
          </div>
        )}
      </div>
    )
  }

  group.items.forEach((item, idx) => {
    if (item.kind === "tool") {
      toolSegment.push({ ...item, index: idx })
      return
    }

    flushToolSegment()
    const isLastThinking = item.data.role === "thinking" && isStreaming && idx === group.items.length - 1
    renderedItems.push(
      <div key={`msg-${item.data.id}`} className="pb-6">
        <ChatMessage
          message={item.data}
          tasks={tasks}
          onReply={onReply}
          isThinkingActive={isLastThinking}
        />
      </div>
    )
  })
  flushToolSegment()

  return (
    <>
      {renderedItems}
      {isStreaming && (
        <div className="mt-6 flex items-center gap-2 text-muted-foreground">
          <span className="flex gap-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce" />
          </span>
          <span className="text-xs">Agent is working...</span>
        </div>
      )}
    </>
  )
}

export const AssistantMessageGroups = memo(function AssistantMessageGroups({
  messages,
  activities,
  tasks,
  onReply,
  isLastGroupStreaming,
}: AssistantMessageGroupsProps) {
  const groups = useMemo(() => {
    const merged = mergeMessagesAndActivities(messages, activities)
    return groupItems(merged)
  }, [messages, activities])

  return (
    <>
      {groups.map((group, idx) => {
        const firstItem = group.items[0]
        const isUser = firstItem?.kind === "message" && firstItem.data.role === "user"
        const isLast = idx === groups.length - 1
        const isStreaming = !isUser && isLast && isLastGroupStreaming

        if (isUser && firstItem?.kind === "message") {
          return (
            <div key={group.id} className="pb-6">
              <ChatMessage
                message={firstItem.data}
                tasks={tasks}
                onReply={onReply}
              />
            </div>
          )
        }

        return (
          <div key={group.id} className="pb-6">
            <AssistantGroup
              group={group}
              tasks={tasks}
              onReply={onReply}
              isStreaming={isStreaming}
            />
          </div>
        )
      })}
    </>
  )
})
