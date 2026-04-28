import { useState, useEffect, useCallback, useRef } from "react"
import type { AgentConfigOption, AgentContentBlock, AgentPlanEntry, WsServerMessage, TaskStatus, ActivityEntry, PromptImage } from "@tangerine/shared"
import { fetchMessages, fetchActivities, fetchTaskConfigOptions, type SessionLog } from "../lib/api"
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
  planEntries?: AgentPlanEntry[]
  contentBlock?: AgentContentBlock
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
  contextTokens: number
  configOptions: AgentConfigOption[]
}

export function applyAssistantStreamMessage(
  messages: ChatMessage[],
  event: { content: string; timestamp?: unknown; images?: ChatMessageImage[] },
  id: string,
  mode: "append" | "complete",
): ChatMessage[] {
  const timestamp = typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString()
  const existing = messages.findIndex((entry) => entry.id === id)
  if (existing === -1) {
    return [...messages, { id, role: "assistant", content: event.content, timestamp, ...(event.images ? { images: event.images } : {}) }]
  }
  return messages.map((entry, index) => {
    if (index !== existing) return entry
    return {
      ...entry,
      content: mode === "append" ? `${entry.content}${event.content}` : event.content,
      ...(mode === "complete" ? { timestamp } : {}),
      ...(event.images ? { images: event.images } : {}),
    }
  })
}

export function applyThinkingStreamMessage(
  messages: ChatMessage[],
  event: { messageId?: unknown; content: string; timestamp?: unknown },
  mode: "append" | "complete",
): ChatMessage[] {
  const messageId = typeof event.messageId === "string" ? event.messageId : "active"
  const id = `thinking-${messageId}`
  const timestamp = typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString()
  const existing = messages.findIndex((entry) => entry.id === id)
  if (existing === -1) {
    return [...messages, { id, role: "thinking", content: event.content, timestamp }]
  }
  return messages.map((entry, index) => {
    if (index !== existing) return entry
    return {
      ...entry,
      content: mode === "append" ? `${entry.content}${event.content}` : event.content,
      ...(mode === "complete" ? { timestamp } : {}),
    }
  })
}

export function applyActivityUpdate(activities: ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  const existing = activities.findIndex((activity) => activity.id === entry.id)
  if (existing === -1) return [...activities, entry]
  return activities.map((activity, index) => index === existing ? entry : activity)
}

export function mergeActivitySnapshot(activities: ActivityEntry[], snapshot: ActivityEntry[]): ActivityEntry[] {
  const byId = new Map<number, ActivityEntry>()
  for (const activity of activities) byId.set(activity.id, activity)
  for (const activity of snapshot) {
    const existing = byId.get(activity.id)
    if (!existing || isNewerActivity(activity, existing)) byId.set(activity.id, activity)
  }
  return [...byId.values()].sort((a, b) => activityStartMs(a) - activityStartMs(b) || a.id - b.id)
}

function isNewerActivity(candidate: ActivityEntry, current: ActivityEntry): boolean {
  return activityFreshnessMs(candidate) > activityFreshnessMs(current)
}

function activityFreshnessMs(activity: ActivityEntry): number {
  const progressAt = activity.metadata?.lastProgressAt
  if (typeof progressAt === "string") {
    const parsed = Date.parse(progressAt)
    if (Number.isFinite(parsed)) return parsed
  }
  return activityStartMs(activity)
}

function activityStartMs(activity: ActivityEntry): number {
  const parsed = Date.parse(activity.timestamp)
  return Number.isFinite(parsed) ? parsed : 0
}

export function useSession(taskId: string, initialContextTokens?: number): UseSessionResult {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activities, setActivities] = useState<ActivityEntry[]>([])
  const [agentStatus, setAgentStatus] = useState<"idle" | "working">("idle")
  const [queueLength, setQueueLength] = useState(0)
  const [taskStatus, setTaskStatus] = useState<TaskStatus | null>(null)
  const [contextTokens, setContextTokens] = useState(initialContextTokens ?? 0)
  const [configOptions, setConfigOptions] = useState<AgentConfigOption[]>([])
  const { connected, messages: wsMessages, send } = useWebSocket(taskId)
  const processedCountRef = useRef(0)
  const activeAssistantStreamIdRef = useRef<string | null>(null)
  // Track optimistic user message IDs so we can deduplicate WS broadcasts
  // without false-positives when the same text is sent twice.
  const pendingOptimisticRef = useRef<Set<string>>(new Set())

  // Sync context tokens when the task's persisted value changes (e.g. on initial load or poll).
  // Reset to 0 when switching tasks and new data hasn't loaded yet.
  useEffect(() => {
    setContextTokens(initialContextTokens ?? 0)
  }, [taskId, initialContextTokens])

  // Clear all session state immediately when the task changes so the previous
  // task's messages/activities/status don't leak into the new one while the
  // REST fetch is in flight. Reset contextTokens to 0 here to clear stale data
  // from the previous task — the sync effect above will update it when the new
  // task's initialContextTokens arrives. This runs AFTER the sync effect, so it
  // overrides any stale initialContextTokens that hasn't updated yet.
  useEffect(() => {
    setMessages([])
    setActivities([])
    setAgentStatus("idle")
    setQueueLength(0)
    setTaskStatus(null)
    setContextTokens(0)
    setConfigOptions([])
    processedCountRef.current = 0
    activeAssistantStreamIdRef.current = null
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
          if (log.role === "plan") {
            try {
              msg.planEntries = JSON.parse(log.content) as AgentPlanEntry[]
            } catch { /* ignore malformed */ }
          }
          if (log.role === "content") {
            try {
              msg.contentBlock = JSON.parse(log.content) as AgentContentBlock
            } catch { /* ignore malformed */ }
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
      setActivities((prev) => mergeActivitySnapshot(prev, data))
    } catch {
      // Activities may not be available yet
    }
    try {
      setConfigOptions(await fetchTaskConfigOptions(taskId))
    } catch {
      // Config options may not be available yet
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
        if (data && typeof data === "object" && data.event === "message.streaming" && typeof data.content === "string") {
          const messageId = typeof data.messageId === "string" ? data.messageId : null
          const id = messageId ? `assistant-${messageId}` : (activeAssistantStreamIdRef.current ?? `assistant-active-${Date.now()}-${Math.random().toString(36).slice(2)}`)
          activeAssistantStreamIdRef.current = id
          setMessages((prev) => applyAssistantStreamMessage(prev, { content: data.content as string, timestamp: data.timestamp }, id, "append"))
          break
        }
        if (data && typeof data === "object" && data.event === "thinking.streaming" && typeof data.content === "string") {
          setMessages((prev) => applyThinkingStreamMessage(prev, data as { messageId?: unknown; content: string; timestamp?: unknown }, "append"))
          break
        }
        if (data && typeof data === "object" && data.event === "thinking.complete" && typeof data.content === "string") {
          setMessages((prev) => applyThinkingStreamMessage(prev, data as { messageId?: unknown; content: string; timestamp?: unknown }, "complete"))
          break
        }
        if (data && typeof data === "object" && data.event === "content.block" && typeof data.block === "object" && data.block !== null) {
          const block = data.block as AgentContentBlock
          setMessages((prev) => [...prev, {
            id: `content-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            role: "content",
            content: JSON.stringify(block),
            timestamp: typeof data.timestamp === "string" ? data.timestamp : new Date().toISOString(),
            contentBlock: block,
          }])
        }
        if (data && typeof data === "object" && data.event === "plan" && Array.isArray(data.entries)) {
          const entries = data.entries as AgentPlanEntry[]
          setMessages((prev) => [...prev, {
            id: `plan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            role: "plan",
            content: JSON.stringify(entries),
            timestamp: typeof data.timestamp === "string" ? data.timestamp : new Date().toISOString(),
            planEntries: entries,
          }])
        }
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
          const messageId = typeof data.messageId === "string" ? data.messageId : null
          if (newMsg.role === "assistant" && (messageId || activeAssistantStreamIdRef.current)) {
            const streamId = messageId ? `assistant-${messageId}` : activeAssistantStreamIdRef.current!
            activeAssistantStreamIdRef.current = null
            setMessages((prev) => applyAssistantStreamMessage(prev, {
              content: newMsg.content,
              timestamp: newMsg.timestamp,
              images: newMsg.images,
            }, streamId, "complete"))
            break
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
            const ev = data as { contextTokens?: number }
            if (typeof ev.contextTokens === "number" && ev.contextTokens > 0) setContextTokens(ev.contextTokens)
          } else if (eventType === "config.options") {
            const ev = data as { configOptions?: unknown }
            if (Array.isArray(ev.configOptions)) setConfigOptions(ev.configOptions as AgentConfigOption[])
          }
        }
        break
      }
      case "activity":
        setActivities((prev) => applyActivityUpdate(prev, msg.entry))
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
      case "ping":
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

  return { messages, activities, agentStatus, queueLength, connected, taskStatus, sendPrompt, abort, contextTokens, configOptions }
}
