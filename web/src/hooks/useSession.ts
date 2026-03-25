import { useState, useEffect, useCallback, useRef } from "react"
import type { WsServerMessage, TaskStatus, ActivityEntry, PromptImage } from "@tangerine/shared"
import { fetchMessages, fetchActivities, type SessionLog } from "../lib/api"
import { useWebSocket } from "./useWebSocket"

export interface ChatMessage {
  id: string
  role: string
  content: string
  timestamp: string
}

interface UseSessionResult {
  messages: ChatMessage[]
  activities: ActivityEntry[]
  agentStatus: "idle" | "working"
  queueLength: number
  connected: boolean
  taskStatus: TaskStatus | null
  sendPrompt: (text: string, images?: PromptImage[]) => void
  abort: () => void
}

export function useSession(taskId: string): UseSessionResult {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activities, setActivities] = useState<ActivityEntry[]>([])
  const [agentStatus, setAgentStatus] = useState<"idle" | "working">("idle")
  const [queueLength, setQueueLength] = useState(0)
  const [taskStatus, setTaskStatus] = useState<TaskStatus | null>(null)
  const { connected, messages: wsMessages, send } = useWebSocket(taskId)
  const processedCountRef = useRef(0)

  // Load initial messages + activities via REST
  useEffect(() => {
    let cancelled = false
    async function loadMessages() {
      try {
        const logs = await fetchMessages(taskId)
        if (cancelled) return
        setMessages(
          logs.map((log: SessionLog) => ({
            id: String(log.id),
            role: log.role,
            content: log.content,
            timestamp: log.timestamp,
          })),
        )
      } catch {
        // Messages may not be available yet
      }
    }
    async function loadActivities() {
      try {
        const data = await fetchActivities(taskId)
        if (!cancelled) setActivities(data)
      } catch {
        // Activities may not be available yet
      }
    }
    loadMessages()
    loadActivities()
    return () => {
      cancelled = true
    }
  }, [taskId])

  // Process new WebSocket messages
  useEffect(() => {
    const newMessages = wsMessages.slice(processedCountRef.current)
    processedCountRef.current = wsMessages.length

    for (const msg of newMessages) {
      handleWsMessage(msg)
    }
  }, [wsMessages])

  function handleWsMessage(msg: WsServerMessage) {
    switch (msg.type) {
      case "event": {
        // Agent events may contain message data
        const data = msg.data as Record<string, unknown> | undefined
        if (data && typeof data === "object" && "role" in data && "content" in data) {
          const newMsg: ChatMessage = {
            id: `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            role: String(data.role),
            content: String(data.content),
            timestamp: typeof data.timestamp === "string" ? data.timestamp : new Date().toISOString(),
          }
          setMessages((prev) => [...prev, newMsg])
        }
        // Track agent working state from events
        if (data && typeof data === "object" && "event" in data) {
          const eventType = String(data.event)
          if (eventType === "agent.start" || eventType === "tool.start") {
            setAgentStatus("working")
          } else if (eventType === "agent.end" || eventType === "agent.idle") {
            setAgentStatus("idle")
          }
        }
        break
      }
      case "activity":
        setActivities((prev) => [...prev, msg.entry])
        break
      case "status":
        setTaskStatus(msg.status)
        if (msg.status === "done" || msg.status === "failed" || msg.status === "cancelled") {
          setAgentStatus("idle")
        }
        break
      case "error":
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: "system",
            content: msg.message,
            timestamp: new Date().toISOString(),
          },
        ])
        break
      case "connected":
        break
    }
  }

  const sendPrompt = useCallback(
    (text: string, images?: PromptImage[]) => {
      // Add user message optimistically
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: "user",
          content: text,
          timestamp: new Date().toISOString(),
        },
      ])
      setAgentStatus("working")
      setQueueLength((q) => q + 1)
      send({ type: "prompt", text, images })
      // Decrement queue after a short delay (server will process)
      setTimeout(() => setQueueLength((q) => Math.max(0, q - 1)), 500)
    },
    [send],
  )

  const abort = useCallback(() => {
    send({ type: "abort" })
    setAgentStatus("idle")
    setQueueLength(0)
  }, [send])

  return { messages, activities, agentStatus, queueLength, connected, taskStatus, sendPrompt, abort }
}
