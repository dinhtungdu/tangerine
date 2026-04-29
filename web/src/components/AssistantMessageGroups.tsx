import { memo, useMemo, type ReactNode } from "react"
import type { ChatMessage as ChatMessageType } from "../hooks/useSession"
import { ChatMessage } from "./ChatMessage"
import {
  deriveChatTimelineGroups,
  deriveStreamingStatusLabel,
  splitTimelineItems,
  type TimelineGroup,
} from "../lib/timeline"
import type { ActivityEntry } from "@tangerine/shared"

interface AssistantMessageGroupsProps {
  messages: ChatMessageType[]
  activities: ActivityEntry[]
  tasks?: ReadonlyArray<{ id: string }>
  onReply?: (content: string) => void
  isLastGroupStreaming: boolean
  footerSlot?: ReactNode
}

function StreamingIndicator({ label }: { label: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-muted-foreground">
      <span className="flex shrink-0 gap-0.5">
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce" />
      </span>
      <span className="block min-w-0 flex-1 truncate text-xs" title={label}>{label}</span>
    </div>
  )
}

function AssistantGroup({
  group,
  tasks,
  onReply,
  isStreaming,
  footerSlot,
}: {
  group: TimelineGroup
  tasks?: ReadonlyArray<{ id: string }>
  onReply?: (content: string) => void
  isStreaming: boolean
  footerSlot?: ReactNode
}) {
  const segments = useMemo(() => splitTimelineItems(group.items), [group.items])

  return (
    <>
      {segments.map((segment) => {
        if (segment.kind === "tool") return null

        const isWorkNote = segment.item.data.role === "thinking" || segment.item.data.role === "narration"
        const isLastThinking = isWorkNote && isStreaming && segment.index === group.items.length - 1
        return (
          <div key={`msg-${segment.item.data.id}`} className="min-w-0 pb-6">
            <ChatMessage
              message={segment.item.data}
              tasks={tasks}
              onReply={onReply}
              isThinkingActive={isLastThinking}
            />
          </div>
        )
      })}
      {(isStreaming || footerSlot) && (
        <div className="mt-6 flex w-full items-center gap-4">
          {isStreaming && <StreamingIndicator label={deriveStreamingStatusLabel(group)} />}
          {footerSlot && <div className="ml-auto shrink-0">{footerSlot}</div>}
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
  footerSlot,
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
            <div key={group.id} className="min-w-0 pb-6">
              <ChatMessage
                message={firstItem.data}
                tasks={tasks}
                onReply={onReply}
              />
            </div>
          )
        }

        return (
          <div key={group.id} className="min-w-0 pb-6">
            <AssistantGroup
              group={group}
              tasks={tasks}
              onReply={onReply}
              isStreaming={isStreaming}
              footerSlot={isLast ? footerSlot : undefined}
            />
          </div>
        )
      })}
    </>
  )
})
