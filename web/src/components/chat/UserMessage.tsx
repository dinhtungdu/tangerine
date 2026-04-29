import { memo } from "react"
import type { UserEntry } from "@/types/thread"

interface UserMessageProps {
  entry: UserEntry
}

export const UserMessage = memo(function UserMessage({ entry }: UserMessageProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium text-foreground">You</div>
      <div className="whitespace-pre-wrap">{entry.content}</div>
      {entry.images && entry.images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {entry.images.map((img, idx) => (
            <img
              key={idx}
              src={img.src}
              alt=""
              className="max-w-xs rounded-md border"
            />
          ))}
        </div>
      )}
    </div>
  )
})
