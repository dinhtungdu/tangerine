import { useState, useEffect, memo } from "react"
import type { AssistantEntry } from "@/types/thread"
import { ThoughtBlock } from "./ThoughtBlock"
import { MarkdownContent } from "./MarkdownContent"

interface ThoughtState {
  expanded: boolean
  startTime: number | null
  duration: number | null
}

interface AssistantMessageProps {
  entry: AssistantEntry
}

export const AssistantMessage = memo(function AssistantMessage({
  entry,
}: AssistantMessageProps) {
  const [thoughtStates, setThoughtStates] = useState<Map<number, ThoughtState>>(
    () => new Map()
  )

  useEffect(() => {
    entry.chunks.forEach((chunk, idx) => {
      if (chunk.type !== "thought") return

      setThoughtStates((prev) => {
        const state = prev.get(idx)
        const next = new Map(prev)

        if (!state && entry.streaming) {
          next.set(idx, { expanded: true, startTime: Date.now(), duration: null })
        } else if (state?.startTime && !entry.streaming && state.duration === null) {
          next.set(idx, {
            expanded: false,
            startTime: state.startTime,
            duration: Math.round((Date.now() - state.startTime) / 1000),
          })
        }

        return next
      })
    })
  }, [entry.chunks.length, entry.streaming])

  const handleToggle = (idx: number) => {
    setThoughtStates((prev) => {
      const next = new Map(prev)
      const current = prev.get(idx)
      next.set(idx, {
        expanded: !current?.expanded,
        startTime: current?.startTime ?? null,
        duration: current?.duration ?? null,
      })
      return next
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {entry.chunks.map((chunk, idx) => {
        if (chunk.type === "thought") {
          const state = thoughtStates.get(idx)
          const isLastChunk = idx === entry.chunks.length - 1
          return (
            <ThoughtBlock
              key={idx}
              content={chunk.content}
              expanded={state?.expanded ?? false}
              duration={state?.duration ?? null}
              streaming={entry.streaming && isLastChunk}
              onToggle={() => handleToggle(idx)}
            />
          )
        }

        return <MarkdownContent key={idx} content={chunk.content} />
      })}
    </div>
  )
})
