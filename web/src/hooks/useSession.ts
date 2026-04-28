import { useState, useEffect, useCallback, useRef } from "react"
import type { AgentConfigOption, AgentContentBlock, AgentPlanEntry, AgentSlashCommand, WsServerMessage, TaskStatus, ActivityEntry, PromptImage, PromptQueueEntry } from "@tangerine/shared"
import { fetchMessages, fetchActivities, fetchQueuedPrompts, fetchTaskConfigOptions, fetchTaskSlashCommands, removeQueuedPrompt, updateQueuedPrompt, type SessionLog } from "../lib/api"
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
  queuedPrompts: PromptQueueEntry[]
  connected: boolean
  taskStatus: TaskStatus | null
  sendPrompt: (text: string, images?: PromptImage[]) => void
  abort: () => void
  updateQueuedPrompt: (promptId: string, text: string) => Promise<void>
  removeQueuedPrompt: (promptId: string) => Promise<void>
  contextTokens: number
  contextWindowMax: number | null
  configOptions: AgentConfigOption[]
  slashCommands: AgentSlashCommand[]
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

export interface UsageState {
  contextTokens: number
  contextWindowMax: number | null
}

export function applyUsageUpdate(state: UsageState, event: { contextTokens?: number; contextWindowMax?: number }): UsageState {
  return {
    contextTokens: typeof event.contextTokens === "number" && event.contextTokens > 0 ? event.contextTokens : state.contextTokens,
    contextWindowMax: typeof event.contextWindowMax === "number" && event.contextWindowMax > 0 ? event.contextWindowMax : state.contextWindowMax,
  }
}

export function useSession(taskId: string, initialContextTokens?: number, initialContextWindowMax?: number | null): UseSessionResult {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activities, setActivities] = useState<ActivityEntry[]>([])
  const [agentStatus, setAgentStatus] = useState<"idle" | "working">("idle")
  const [queuedPrompts, setQueuedPrompts] = useState<PromptQueueEntry[]>([])
  const [taskStatus, setTaskStatus] = useState<TaskStatus | null>(null)
  const [contextTokens, setContextTokens] = useState(initialContextTokens ?? 0)
  const [contextWindowMax, setContextWindowMax] = useState<number | null>(initialContextWindowMax ?? null)
  const [configOptions, setConfigOptions] = useState<AgentConfigOption[]>([])
  const [slashCommands, setSlashCommands] = useState<AgentSlashCommand[]>([])
  const { connected, messages: wsMessages, send } = useWebSocket(taskId)
  const activeTaskIdRef = useRef(taskId)
  activeTaskIdRef.current = taskId
  const processedCountRef = useRef(0)
  const activeAssistantStreamIdRef = useRef<string | null>(null)
  // Track optimistic user message IDs so we can deduplicate WS broadcasts
  // without false-positives when the same text is sent twice.
  // Map value: true = server-acknowledged (WS broadcast received), false = not yet
  const pendingOptimisticRef = useRef<Map<string, boolean>>(new Map())

  // Sync context usage when persisted task values change (e.g. on initial load or poll).
  // Reset when switching tasks and new data hasn't loaded yet.
  useEffect(() => {
    setContextTokens(initialContextTokens ?? 0)
    setContextWindowMax(initialContextWindowMax ?? null)
  }, [taskId, initialContextTokens, initialContextWindowMax])

  // Clear all session state immediately when the task changes so the previous
  // task's messages/activities/status don't leak into the new one while the
  // REST fetch is in flight. Reset context usage here to clear stale data from
  // the previous task. This runs AFTER the sync effect, so it overrides stale
  // initial values until the new task data arrives.
  useEffect(() => {
    setMessages([])
    setActivities([])
    setAgentStatus("idle")
    setQueuedPrompts([])
    setTaskStatus(null)
    setContextTokens(0)
    setContextWindowMax(null)
    setConfigOptions([])
    setSlashCommands([])
    processedCountRef.current = 0
    activeAssistantStreamIdRef.current = null
  }, [taskId])

  // Load initial messages + activities via REST
  const refreshFromRest = useCallback(async () => {
    const refreshTaskId = taskId
    const isCurrentTask = () => activeTaskIdRef.current === refreshTaskId

    try {
      const logs = await fetchMessages(refreshTaskId)
      if (!isCurrentTask()) return
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
              msg.images = filenames.map((f) => ({ src: `/api/tasks/${refreshTaskId}/images/${f}` }))
            } catch { /* ignore malformed */ }
          }
          return msg
        }),
      )
    } catch {
      // Messages may not be available yet
    }
    if (!isCurrentTask()) return
    try {
      const data = await fetchActivities(refreshTaskId)
      if (!isCurrentTask()) return
      setActivities((prev) => mergeActivitySnapshot(prev, data))
    } catch {
      // Activities may not be available yet
    }
    if (!isCurrentTask()) return
    try {
      const options = await fetchTaskConfigOptions(refreshTaskId)
      if (!isCurrentTask()) return
      setConfigOptions(options)
    } catch {
      // Session config may not be available yet
    }
    if (!isCurrentTask()) return
    try {
      const commands = await fetchTaskSlashCommands(refreshTaskId)
      if (!isCurrentTask()) return
      setSlashCommands(commands)
    } catch {
      // Slash commands may not be available yet
    }
    if (!isCurrentTask()) return
    try {
      const queued = await fetchQueuedPrompts(refreshTaskId)
      if (!isCurrentTask()) return
      setQueuedPrompts(queued)
    } catch {
      // Queue may not be available yet
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
            // Mark as acknowledged (don't delete) so queue handler can check later.
            // Only match unacknowledged entries to avoid matching stale ones.
            if (newMsg.role === "user" && pendingOptimisticRef.current.size > 0) {
              const matchId = [...pendingOptimisticRef.current.entries()].find(([id, acknowledged]) => {
                if (acknowledged) return false
                const opt = prev.find((m) => m.id === id)
                return opt && opt.content === newMsg.content
              })?.[0]
              if (matchId) {
                pendingOptimisticRef.current.set(matchId, true)
                // Clear any stale acknowledged entries with same content to prevent buildup
                const matchContent = prev.find((m) => m.id === matchId)?.content
                for (const [id, ack] of pendingOptimisticRef.current) {
                  if (id !== matchId && ack) {
                    const entry = prev.find((m) => m.id === id)
                    if (entry?.content === matchContent) {
                      pendingOptimisticRef.current.delete(id)
                    }
                  }
                }
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
            const ev = data as { contextTokens?: number; contextWindowMax?: number }
            setContextTokens((prev) => applyUsageUpdate({ contextTokens: prev, contextWindowMax: null }, ev).contextTokens)
            setContextWindowMax((prev) => applyUsageUpdate({ contextTokens: 0, contextWindowMax: prev }, ev).contextWindowMax)
          } else if (eventType === "config.options") {
            const ev = data as { configOptions?: unknown }
            if (Array.isArray(ev.configOptions)) setConfigOptions(ev.configOptions as AgentConfigOption[])
          } else if (eventType === "slash.commands") {
            const ev = data as { commands?: unknown }
            if (Array.isArray(ev.commands)) setSlashCommands(ev.commands as AgentSlashCommand[])
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
      case "queue":
        // If queue contains a message we optimistically added to chat, remove from chat.
        // This fixes the race where client thinks agent idle but server queues (agent busy).
        // Only match against server-acknowledged entries in pendingOptimisticRef to avoid
        // removing legitimate chat history (e.g. duplicate messages, or messages from reconnect).
        setMessages((prev) => {
          if (pendingOptimisticRef.current.size === 0) return prev
          const toRemove = new Set<string>()
          // Build list of queued texts for matching (handle duplicates with 1:1 matching)
          const queuedTexts = msg.queuedPrompts.map((e) => e.text)
          for (const [optimisticId, acknowledged] of pendingOptimisticRef.current) {
            // Only check acknowledged entries (server received, may have queued)
            if (!acknowledged) continue
            const opt = prev.find((m) => m.id === optimisticId)
            if (!opt) continue
            const matchIdx = queuedTexts.indexOf(opt.content)
            if (matchIdx !== -1) {
              toRemove.add(optimisticId)
              pendingOptimisticRef.current.delete(optimisticId)
              // Remove matched text to handle duplicate sends correctly (1:1 matching)
              queuedTexts.splice(matchIdx, 1)
            } else {
              // Acknowledged but not in queue = message was processed, not queued. Clear tracking.
              pendingOptimisticRef.current.delete(optimisticId)
            }
          }
          if (toRemove.size === 0) return prev
          return prev.filter((m) => !toRemove.has(m.id))
        })
        setQueuedPrompts(msg.queuedPrompts)
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
      const shouldQueue = agentStatus === "working"
      if (!shouldQueue && (text || images?.length)) {
        const optimisticId = `user-${Date.now()}`
        pendingOptimisticRef.current.set(optimisticId, false)
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
        setAgentStatus("working")
      }
      send({ type: "prompt", text, images })
    },
    [agentStatus, send],
  )

  const abort = useCallback(() => {
    send({ type: "abort" })
    setAgentStatus("idle")
  }, [send])

  const handleUpdateQueuedPrompt = useCallback(async (promptId: string, text: string) => {
    const updated = await updateQueuedPrompt(taskId, promptId, text)
    setQueuedPrompts((prev) => prev.map((entry) => entry.id === promptId ? updated : entry))
  }, [taskId])

  const handleRemoveQueuedPrompt = useCallback(async (promptId: string) => {
    await removeQueuedPrompt(taskId, promptId)
    setQueuedPrompts((prev) => prev.filter((entry) => entry.id !== promptId))
  }, [taskId])

  return { messages, activities, agentStatus, queueLength: queuedPrompts.length, queuedPrompts, connected, taskStatus, sendPrompt, abort, updateQueuedPrompt: handleUpdateQueuedPrompt, removeQueuedPrompt: handleRemoveQueuedPrompt, contextTokens, contextWindowMax, configOptions, slashCommands }
}
