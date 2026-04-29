// Thread session hook - connects WebSocket to useThread for chat v2

import { useEffect, useCallback, useRef } from "react"
import type { WsServerMessage, StreamEvent, PromptImage } from "@tangerine/shared"
import { useThread } from "./useThread"
import { useWebSocket } from "./useWebSocket"
import type { ThreadEntry, MessageImage } from "@/types/thread"

interface UseThreadSessionOptions {
  taskId: string
  initialEntries?: ThreadEntry[]
}

interface UseThreadSessionResult {
  entries: ThreadEntry[]
  connected: boolean
  sendPrompt: (content: string, images?: PromptImage[]) => void
  abort: () => void
}

export function useThreadSession({
  taskId,
  initialEntries,
}: UseThreadSessionOptions): UseThreadSessionResult {
  const { entries, enqueueEvent, clearEntries } = useThread({
    initialEntries,
  })

  const { connected, messages: wsMessages, send } = useWebSocket(taskId)
  const processedCount = useRef(0)

  // Reset when task changes
  useEffect(() => {
    clearEntries()
    processedCount.current = 0
  }, [taskId, clearEntries])

  // Process WebSocket messages
  useEffect(() => {
    const newMessages = wsMessages.slice(processedCount.current)
    processedCount.current = wsMessages.length

    for (const msg of newMessages) {
      handleWsMessage(msg)
    }
  }, [wsMessages])

  const handleWsMessage = useCallback(
    (msg: WsServerMessage) => {
      if (msg.type === "stream") {
        // v2 stream events - enqueue directly
        enqueueEvent(msg.event as StreamEvent)
      }
      // v1 events are handled by existing useSession - we ignore them here
    },
    [enqueueEvent]
  )

  const sendPrompt = useCallback(
    (content: string, images?: PromptImage[]) => {
      // Convert PromptImage to MessageImage for UI display
      const uiImages: MessageImage[] | undefined = images?.map((img) => ({
        src: `data:${img.mediaType};base64,${img.data}`,
        mediaType: img.mediaType,
      }))

      // Add optimistic user message
      enqueueEvent({
        type: "user.message",
        id: crypto.randomUUID(),
        content,
        images: uiImages,
      })

      // Send to server (already in PromptImage format)
      send({
        type: "prompt",
        text: content,
        images,
      })
    },
    [enqueueEvent, send]
  )

  const abort = useCallback(() => {
    send({ type: "abort" })
  }, [send])

  return {
    entries,
    connected,
    sendPrompt,
    abort,
  }
}
