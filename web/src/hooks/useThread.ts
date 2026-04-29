// Thread state hook with RAF batching (from obsidian-agent-client)

import { useState, useRef, useCallback, useEffect } from "react"
import type { StreamEvent } from "@/types/events"
import type { ThreadEntry, MessageImage } from "@/types/thread"
import { applyStreamEvent } from "@/lib/thread-reducer"

interface UseThreadOptions {
  initialEntries?: ThreadEntry[]
}

interface UseThreadResult {
  entries: ThreadEntry[]
  enqueueEvent: (event: StreamEvent) => void
  addUserMessage: (content: string, images?: MessageImage[]) => void
  clearEntries: () => void
  setEntries: (entries: ThreadEntry[]) => void
}

export function useThread(options: UseThreadOptions = {}): UseThreadResult {
  const [entries, setEntries] = useState<ThreadEntry[]>(options.initialEntries ?? [])
  const pendingUpdates = useRef<StreamEvent[]>([])
  const flushScheduled = useRef(false)
  const toolCallIndex = useRef<Map<string, number>>(new Map())

  const flushPendingUpdates = useCallback(() => {
    flushScheduled.current = false
    const batch = pendingUpdates.current
    pendingUpdates.current = []
    if (batch.length === 0) return

    setEntries((prev) => {
      let next = prev
      for (const event of batch) {
        next = applyStreamEvent(next, event, toolCallIndex.current)
      }
      return next
    })
  }, [])

  const enqueueEvent = useCallback(
    (event: StreamEvent) => {
      pendingUpdates.current.push(event)
      if (!flushScheduled.current) {
        flushScheduled.current = true
        requestAnimationFrame(flushPendingUpdates)
      }
    },
    [flushPendingUpdates]
  )

  const addUserMessage = useCallback((content: string, images?: MessageImage[]) => {
    const event: StreamEvent = {
      type: "user.message",
      id: crypto.randomUUID(),
      content,
      images,
    }
    enqueueEvent(event)
  }, [enqueueEvent])

  const clearEntries = useCallback(() => {
    setEntries([])
    toolCallIndex.current.clear()
    pendingUpdates.current = []
  }, [])

  // Clear index when entries reset
  useEffect(() => {
    if (entries.length === 0) {
      toolCallIndex.current.clear()
    }
  }, [entries.length])

  return {
    entries,
    enqueueEvent,
    addUserMessage,
    clearEntries,
    setEntries,
  }
}
