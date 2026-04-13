import { useState, useEffect, useCallback, useRef } from "react"
import type { WsServerMessage, TaskStatus, ActivityEntry, PromptImage } from "@tangerine/shared"
import { fetchMessages, fetchActivities, type SessionLog } from "../lib/api"
import { useWebSocket } from "./useWebSocket"

export interface ChatMessageImage {
  src: string
}

export interface ChatMessage {
  id: string
  role: string
  content: string
  timestamp: string
  images?: ChatMessageImage[]
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
  inputTokens: number
  outputTokens: number
  contextTokens: number
}

export function useSession(taskId: string, initialTokens?: { inputTokens: number; outputTokens: number }): UseSessionResult {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activities, setActivities] = useState<ActivityEntry[]>([])
  const [agentStatus, setAgentStatus] = useState<"idle" | "working">("idle")
  const [queueLength, setQueueLength] = useState(0)
  const [taskStatus, setTaskStatus] = useState<TaskStatus | null>(null)
  const [inputTokens, setInputTokens] = useState(initialTokens?.inputTokens ?? 0)
  const [outputTokens, setOutputTokens] = useState(initialTokens?.outputTokens ?? 0)
  const [contextTokens, setContextTokens] = useState(0)
  const { connected, messages: wsMessages, send } = useWebSocket(taskId)
  const processedCountRef = useRef(0)
  // Track optimistic user message IDs so we can deduplicate WS broadcasts
  // without false-positives when the same text is sent twice.
  const pendingOptimisticRef = useRef<Set<string>>(new Set())

  // Sync token counts when the task's persisted values change (e.g. on initial load or poll)
  useEffect(() => {
    if (initialTokens) {
      setInputTokens(initialTokens.inputTokens)
      setOutputTokens(initialTokens.outputTokens)
    }
  }, [taskId, initialTokens?.inputTokens, initialTokens?.outputTokens])

  // Clear all session state immediately when the task changes so the previous
  // task's messages/activities/status don't leak into the new one while the
  // REST fetch is in flight.
  useEffect(() => {
    setMessages([])
    setActivities([])
    setAgentStatus("idle")
    setQueueLength(0)
    setTaskStatus(null)
    setInputTokens(0)
    setOutputTokens(0)
    setContextTokens(0)
    processedCountRef.current = 0
  }, [taskId])

  // Load initial messages + activities via REST
  const refreshFromRest = useCallback(async () => {
    try {
      const logs = await fetchMessages(taskId)
      setMessages(
        logs.map((log: SessionLog) => {
          const msg: ChatMessage = {
            id: String(log.id),
            role: log.role,
            content: log.content,
            timestamp: log.timestamp,
          }
          if (log.images) {
            try {
              const filenames = JSON.parse(log.images) as string[]
              msg.images = filenames.map((f) => ({ src: `/api/tasks/${taskId}/images/${f}` }))
            } catch { /* ignore malformed */ }
          }
          return msg
        }),
      )
    } catch {
      // Messages may not be available yet
    }
    try {
      const data = await fetchActivities(taskId)
      setActivities(data)
    } catch {
      // Activities may not be available yet
    }
  }, [taskId])

  useEffect(() => {
    let cancelled = false
    refreshFromRest().then(() => { if (cancelled) { /* component unmounted, ignore */ } })
    return () => { cancelled = true }
  }, [refreshFromRest])

  // Re-fetch full state when the page becomes visible again (e.g. returning
  // from background on iOS Safari) to pick up messages missed while the
  // WebSocket was disconnected.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        refreshFromRest()
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [refreshFromRest])

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
          // Handle agent-produced images (filenames saved by server)
          const imgData = (data as Record<string, unknown>).images
          if (Array.isArray(imgData)) {
            newMsg.images = (imgData as string[]).map((f) => ({ src: `/api/tasks/${taskId}/images/${f}` }))
          }
          setMessages((prev) => {
            // Deduplicate: if this tab sent the message optimistically, skip
            // the WS broadcast. Match by content against pending optimistic IDs
            // so sending the same text twice still works correctly.
            if (newMsg.role === "user" && pendingOptimisticRef.current.size > 0) {
              const matchId = [...pendingOptimisticRef.current].find((id) => {
                const opt = prev.find((m) => m.id === id)
                return opt && opt.content === newMsg.content
              })
              if (matchId) {
                pendingOptimisticRef.current.delete(matchId)
                return prev
              }
            }
            return [...prev, newMsg]
          })
        }
        // Track agent working state from events
        if (data && typeof data === "object" && "event" in data) {
          const eventType = String(data.event)
          if (eventType === "agent.start" || eventType === "tool.start") {
            setAgentStatus("working")
          } else if (eventType === "agent.end" || eventType === "agent.idle") {
            setAgentStatus("idle")
          } else if (eventType === "usage") {
            const ev = data as { inputTokens?: number; outputTokens?: number; contextTokens?: number }
            if (typeof ev.inputTokens === "number") setInputTokens(ev.inputTokens)
            if (typeof ev.outputTokens === "number") setOutputTokens(ev.outputTokens)
            if (typeof ev.contextTokens === "number" && ev.contextTokens > 0) setContextTokens(ev.contextTokens)
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
        // Don't set "working" from task status "running" — a running task may
        // have an idle agent. The server sends a separate "agent_status" message
        // with the actual working state.
        break
      case "agent_status":
        setAgentStatus(msg.agentStatus)
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
      // Add user message optimistically so the sender sees it immediately.
      // The server also broadcasts a WS event to all clients; the handleWsMessage
      // handler deduplicates so this tab won't show the message twice.
      if (text || images?.length) {
        const optimisticId = `user-${Date.now()}`
        pendingOptimisticRef.current.add(optimisticId)
        setMessages((prev) => [
          ...prev,
          {
            id: optimisticId,
            role: "user",
            content: text,
            timestamp: new Date().toISOString(),
            images: images?.map((img) => ({ src: `data:${img.mediaType};base64,${img.data}` })),
          },
        ])
      }
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

  return { messages, activities, agentStatus, queueLength, connected, taskStatus, sendPrompt, abort, inputTokens, outputTokens, contextTokens }
}
