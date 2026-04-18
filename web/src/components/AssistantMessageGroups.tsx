import { memo, useState, useCallback, useMemo, useEffect } from "react"
import type { ActivityEntry } from "@tangerine/shared"
import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { ChatMessage } from "./ChatMessage"
import { ToolCallDisplay } from "./ToolCallDisplay"
import { ToolCallsSummaryBar } from "./ToolCallsSummaryBar"

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
  toolCount: number
  filesChanged: number
  hasError: boolean
  hasToolsOrThinking: boolean
}

function isToolActivity(activity: ActivityEntry): boolean {
  return activity.event.startsWith("tool.")
}

function isWriteOrEditActivity(activity: ActivityEntry): boolean {
  const meta = activity.metadata as { tool?: string } | null
  const toolName = (meta?.tool || "").toLowerCase()
  return toolName.includes("write") || toolName.includes("edit")
}

function getFilePathFromActivity(activity: ActivityEntry): string | null {
  const meta = activity.metadata as { path?: string; file_path?: string } | null
  return meta?.path || meta?.file_path || null
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
    let hasError = false
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
        if (meta?.status === "error") hasError = true
      } else if (item.data.role === "thinking" || item.data.role === "narration") {
        hasToolsOrThinking = true
      }
    }

    const firstItem = currentGroup[0]!
    const id = firstItem.kind === "message" ? firstItem.data.id : `activity-${firstItem.data.id}`

    groups.push({
      id,
      items: currentGroup,
      startTime: groupStartTime,
      toolCount,
      filesChanged: changedFiles.size,
      hasError,
      hasToolsOrThinking,
    })
    currentGroup = []
    groupStartTime = ""
  }

  for (const item of items) {
    if (item.kind === "message" && item.data.role === "user") {
      flushGroup()
      groups.push({
        id: item.data.id,
        items: [item],
        startTime: item.data.timestamp,
        toolCount: 0,
        filesChanged: 0,
        hasError: false,
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
  return JSON.stringify({
    tool: meta?.tool || activity.event.replace("tool.", ""),
    name: meta?.tool || activity.event.replace("tool.", ""),
    ...meta,
  })
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
  const [expanded, setExpanded] = useState(() => group.hasError)

  useEffect(() => {
    if (group.hasError) setExpanded(true)
  }, [group.hasError])

  const handleToggle = useCallback(() => {
    setExpanded((v) => !v)
  }, [])

  const textMessages = useMemo(
    () => group.items.filter(
      (item): item is { kind: "message"; data: ChatMessageType } =>
        item.kind === "message" &&
        item.data.role !== "thinking" &&
        item.data.role !== "narration" &&
        item.data.role === "assistant"
    ),
    [group.items],
  )

  const showSummaryBar = group.toolCount >= 2

  if (!showSummaryBar) {
    return (
      <>
        {group.items.map((item) => {
          if (item.kind === "tool") {
            const meta = item.data.metadata as { status?: string } | null
            const status = meta?.status === "error" ? "error" : meta?.status === "running" ? "running" : "success"
            return (
              <div key={`tool-${item.data.id}`} className="pb-6">
                <ToolCallDisplay
                  content={buildToolContent(item.data)}
                  status={status as "running" | "success" | "error"}
                />
              </div>
            )
          }
          return (
            <div key={item.data.id} className="pb-6">
              <ChatMessage message={item.data} tasks={tasks} onReply={onReply} />
            </div>
          )
        })}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <ToolCallsSummaryBar
        isStreaming={isStreaming}
        startTime={group.startTime}
        toolCount={group.toolCount}
        filesChanged={group.filesChanged}
        hasError={group.hasError}
        expanded={expanded}
        onToggle={handleToggle}
      />

      {expanded && (
        <div className="flex flex-col gap-4 pl-2 border-l-2 border-border">
          {group.items.map((item, idx) => {
            if (item.kind === "tool") {
              const meta = item.data.metadata as { status?: string } | null
              const status = meta?.status === "error" ? "error" : meta?.status === "running" ? "running" : "success"
              return (
                <ToolCallDisplay
                  key={`tool-${item.data.id}`}
                  content={buildToolContent(item.data)}
                  status={status as "running" | "success" | "error"}
                />
              )
            }
            const isLastThinking =
              item.data.role === "thinking" && isStreaming && idx === group.items.length - 1
            return (
              <ChatMessage
                key={item.data.id}
                message={item.data}
                tasks={tasks}
                onReply={onReply}
                isThinkingActive={isLastThinking}
              />
            )
          })}
        </div>
      )}

      {!expanded && textMessages.length > 0 && (
        <div className="flex flex-col gap-6">
          {textMessages.map((item) => (
            <ChatMessage key={item.data.id} message={item.data} tasks={tasks} onReply={onReply} />
          ))}
        </div>
      )}
    </div>
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
