import { memo, useState, useCallback, useMemo } from "react"
import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { ChatMessage } from "./ChatMessage"
import { ToolCallDisplay } from "./ToolCallDisplay"
import { ToolCallsSummaryBar } from "./ToolCallsSummaryBar"
import {
  buildToolContent,
  deriveChatTimelineGroups,
  deriveStreamingStatusLabel,
  deriveToolStatus,
  getLastToolIndex,
  splitToolSegments,
  type TimelineGroup,
} from "../lib/timeline"
import type { ActivityEntry } from "@tangerine/shared"

interface AssistantMessageGroupsProps {
  messages: ChatMessageType[]
  activities: ActivityEntry[]
  tasks?: ReadonlyArray<{ id: string }>
  onReply?: (content: string) => void
  isLastGroupStreaming: boolean
}

function toolSegmentId(items: ReadonlyArray<{ data: ActivityEntry }>): string {
  return `tools-${items[0]?.data.id ?? "empty"}`
}

function isToolSegmentStreaming(
  items: ReadonlyArray<{ data: ActivityEntry; index: number }>,
  { isStreaming, lastToolIdx }: { isStreaming: boolean; lastToolIdx: number },
): boolean {
  return items.some((item) => deriveToolStatus(item.data, {
    isStreaming,
    isLastTool: item.index === lastToolIdx,
  }) === "running")
}

function StreamingIndicator({ label }: { label: string }) {
  return (
    <div className="mt-6 flex items-center gap-2 text-muted-foreground">
      <span className="flex gap-0.5">
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce" />
      </span>
      <span className="text-xs">{label}</span>
    </div>
  )
}

function AssistantGroup({
  group,
  tasks,
  onReply,
  isStreaming,
}: {
  group: TimelineGroup
  tasks?: ReadonlyArray<{ id: string }>
  onReply?: (content: string) => void
  isStreaming: boolean
}) {
  const [expandedSegmentIds, setExpandedSegmentIds] = useState<ReadonlySet<string>>(() => new Set())

  const handleToggle = useCallback((id: string) => {
    setExpandedSegmentIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const lastToolIdx = useMemo(() => getLastToolIndex(group.items), [group.items])
  const segments = useMemo(() => splitToolSegments(group.items), [group.items])

  return (
    <>
      {segments.map((segment) => {
        if (segment.kind === "tool") {
          const status = deriveToolStatus(segment.item.data, {
            isStreaming,
            isLastTool: segment.index === lastToolIdx,
          })
          return (
            <div key={`tool-${segment.item.data.id}`} className="pb-6">
              <ToolCallDisplay content={buildToolContent(segment.item.data)} status={status} />
            </div>
          )
        }

        if (segment.kind === "tool-segment") {
          const id = toolSegmentId(segment.items)
          const expanded = expandedSegmentIds.has(id)
          const segmentIsStreaming = isToolSegmentStreaming(segment.items, { isStreaming, lastToolIdx })

          return (
            <div key={id} className="pb-6 flex flex-col gap-3">
              <ToolCallsSummaryBar
                isStreaming={segmentIsStreaming}
                startTime={segment.summary.startTime}
                endTime={segment.summary.endTime}
                toolCount={segment.summary.toolCount}
                filesChanged={segment.summary.filesChanged}
                errorCount={segment.summary.errorCount}
                expanded={expanded}
                onToggle={() => handleToggle(id)}
              />
              {expanded && (
                <div className="flex flex-col gap-4 pl-2 border-l-2 border-border">
                  {segment.items.map((item) => {
                    const status = deriveToolStatus(item.data, {
                      isStreaming,
                      isLastTool: item.index === lastToolIdx,
                    })
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

        const isLastThinking = segment.item.data.role === "thinking" && isStreaming && segment.index === group.items.length - 1
        return (
          <div key={`msg-${segment.item.data.id}`} className="pb-6">
            <ChatMessage
              message={segment.item.data}
              tasks={tasks}
              onReply={onReply}
              isThinkingActive={isLastThinking}
            />
          </div>
        )
      })}
      {isStreaming && <StreamingIndicator label={deriveStreamingStatusLabel(group)} />}
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
  const groups = useMemo(() => deriveChatTimelineGroups({ messages, activities }), [messages, activities])

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
