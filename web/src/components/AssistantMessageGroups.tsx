import { memo, useState, useCallback, useMemo } from "react"
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
  onOpenTerminal?: () => void
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
  onOpenTerminal,
  isStreaming,
}: {
  group: MessageGroup
  tasks?: ReadonlyArray<{ id: string }>
  onReply?: (content: string) => void
  onOpenTerminal?: () => void
  isStreaming: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  const handleToggle = useCallback(() => {
    setExpanded((v) => !v)
  }, [])

  const textMessages = useMemo(
    () => group.items.filter(
      (item): item is { kind: "message"; data: ChatMessageType } =>
        item.kind === "message" &&
        item.data.role === "assistant"
    ),
    [group.items],
  )

  const showSummaryBar = group.toolCount >= 2

  // Find the last tool index for status derivation
  const lastToolIdx = useMemo(() => {
    for (let i = group.items.length - 1; i >= 0; i--) {
      if (group.items[i]!.kind === "tool") return i
    }
    return -1
  }, [group.items])

  if (!showSummaryBar) {
    return (
      <>
        {group.items.map((item, idx) => {
          if (item.kind === "tool") {
            const status = deriveToolStatus(item.data, isStreaming, idx === lastToolIdx)
            return (
              <div key={`tool-${item.data.id}`} className="pb-6">
                <ToolCallDisplay
                  content={buildToolContent(item.data)}
                  status={status}
                />
              </div>
            )
          }
          return (
            <div key={`msg-${item.data.id}`} className="pb-6">
              <ChatMessage message={item.data} tasks={tasks} onReply={onReply} onOpenTerminal={onOpenTerminal} />
            </div>
          )
        })}
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

  return (
    <div className="flex flex-col gap-3">
      <ToolCallsSummaryBar
        isStreaming={isStreaming}
        startTime={group.startTime}
        endTime={group.endTime}
        toolCount={group.toolCount}
        filesChanged={group.filesChanged}
        errorCount={group.errorCount}
        expanded={expanded}
        onToggle={handleToggle}
      />

      {expanded && (
        <>
          <div className="flex flex-col gap-4 pl-2 border-l-2 border-border">
            {group.items.map((item, idx) => {
              if (item.kind === "tool") {
                const status = deriveToolStatus(item.data, isStreaming, idx === lastToolIdx)
                return (
                  <ToolCallDisplay
                    key={`tool-${item.data.id}`}
                    content={buildToolContent(item.data)}
                    status={status}
                  />
                )
              }
              if (item.data.role === "assistant") return null
              const isLastThinking =
                item.data.role === "thinking" && isStreaming && idx === group.items.length - 1
              return (
                <ChatMessage
                  key={`msg-${item.data.id}`}
                  message={item.data}
                  tasks={tasks}
                  onReply={onReply}
                  onOpenTerminal={onOpenTerminal}
                  isThinkingActive={isLastThinking}
                />
              )
            })}
          </div>
          <ToolCallsSummaryBar
            isStreaming={isStreaming}
            startTime={group.startTime}
            endTime={group.endTime}
            toolCount={group.toolCount}
            filesChanged={group.filesChanged}
            errorCount={group.errorCount}
            expanded={expanded}
            onToggle={handleToggle}
          />
        </>
      )}

      {textMessages.length > 0 && (
        <div className="flex flex-col gap-6">
          {textMessages.map((item) => (
            <ChatMessage key={`msg-${item.data.id}`} message={item.data} tasks={tasks} onReply={onReply} onOpenTerminal={onOpenTerminal} />
          ))}
        </div>
      )}

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
    </div>
  )
}

export const AssistantMessageGroups = memo(function AssistantMessageGroups({
  messages,
  activities,
  tasks,
  onReply,
  onOpenTerminal,
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
                onOpenTerminal={onOpenTerminal}
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
              onOpenTerminal={onOpenTerminal}
              isStreaming={isStreaming}
            />
          </div>
        )
      })}
    </>
  )
})
