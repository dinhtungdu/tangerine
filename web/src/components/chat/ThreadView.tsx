import { memo } from "react"
import type { ThreadEntry } from "@/types/thread"
import { UserMessage } from "./UserMessage"
import { AssistantMessage } from "./AssistantMessage"
import { ToolCallDisplay } from "./ToolCallDisplay"
import { PlanDisplay } from "./PlanDisplay"

interface ThreadViewProps {
  entries: ThreadEntry[]
  onPermissionRespond?: (requestId: string, optionId: string) => void
}

export const ThreadView = memo(function ThreadView({
  entries,
  onPermissionRespond,
}: ThreadViewProps) {
  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No messages yet
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      {entries.map((entry) => {
        switch (entry.kind) {
          case "user":
            return <UserMessage key={entry.id} entry={entry} />
          case "assistant":
            return <AssistantMessage key={entry.id} entry={entry} />
          case "tool_call":
            return (
              <ToolCallDisplay
                key={entry.id}
                entry={entry}
                onPermissionRespond={onPermissionRespond}
              />
            )
          case "plan":
            return <PlanDisplay key={entry.id} entry={entry} />
        }
      })}
    </div>
  )
})
