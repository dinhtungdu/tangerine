import { useState, useEffect, useCallback, useRef } from "react"
import type { AgentConfigOption, AgentContentBlock, AgentPlanEntry, AgentSlashCommand, WsServerMessage, TaskStatus, ActivityEntry, PromptImage, PromptQueueEntry } from "@tangerine/shared"
import { fetchMessagesPaginated, fetchActivities, fetchQueuedPrompts, fetchTaskConfigOptions, fetchTaskSlashCommands, removeQueuedPrompt, updateQueuedPrompt, type SessionLog } from "../lib/api"
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
  clearAllQueuedPrompts: () => Promise<void>
  sendNowQueuedPrompt: (promptId: string) => Promise<void>
  contextTokens: number
  contextWindowMax: number | null
  configOptions: AgentConfigOption[]
  slashCommands: AgentSlashCommand[]
  hasMoreMessages: boolean
  loadingOlderMessages: boolean
  loadOlderMessages: () => Promise<void>
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

export function mergeMessageSnapshot(current: ChatMessage[], snapshot: ChatMessage[], requestedAtMs: number): ChatMessage[] {
  const additions: ChatMessage[] = []
  for (const message of current) {
    if (messageTimestampMs(message) < requestedAtMs) continue
    if (isMessageRepresented(message, snapshot) || isMessageRepresented(message, additions)) continue
    additions.push(message)
  }
  return additions.length > 0 ? [...snapshot, ...additions] : snapshot
}

function isMessageRepresented(message: ChatMessage, candidates: ChatMessage[]): boolean {
  const messageMs = messageTimestampMs(message)
  return candidates.some((candidate) => {
    if (candidate.role !== message.role || candidate.content !== message.content) return false
    const candidateMs = messageTimestampMs(candidate)
    return messageMs === 0 || candidateMs === 0 || candidateMs >= messageMs
  })
}

function messageTimestampMs(message: Pick<ChatMessage, "timestamp">): number {
  const parsed = Date.parse(message.timestamp)
  return Number.isFinite(parsed) ? parsed : 0
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

export const QUEUE_FLASH_SUPPRESS_MS = 800
const QUEUE_OPTIMISTIC_TTL_MS = 30000

interface PendingOptimisticPrompt {
  acknowledged: boolean
  content: string
  images?: PromptImage[]
  sentAt: number
  revealTimer: ReturnType<typeof setTimeout>
  cleanupTimer: ReturnType<typeof setTimeout>
}

function queuedPromptDisplayText(entry: PromptQueueEntry): string {
  return entry.displayText ?? entry.text
}

function clonePromptImages(images?: PromptImage[]): PromptImage[] | undefined {
  if (!images || images.length === 0) return undefined
  return images.map((image) => ({ ...image }))
}

function promptImagesEqual(left?: PromptImage[], right?: PromptImage[]): boolean {
  const leftImages = left ?? []
  const rightImages = right ?? []
  if (leftImages.length !== rightImages.length) return false
  return leftImages.every((image, index) => {
    const other = rightImages[index]
    return other !== undefined && image.mediaType === other.mediaType && image.data === other.data
  })
}

function queuedPromptMatchesPending(
  entry: PromptQueueEntry,
  pending: Pick<PendingOptimisticPrompt, "content" | "images">,
): boolean {
  return queuedPromptDisplayText(entry) === pending.content && promptImagesEqual(entry.images, pending.images)
}

export function filterVisibleQueuedPrompts(
  queuedPrompts: PromptQueueEntry[],
  pendingOptimistic: ReadonlyMap<string, Pick<PendingOptimisticPrompt, "content" | "images" | "sentAt">>,
  now: number,
): PromptQueueEntry[] {
  const suppressiblePrompts = [...pendingOptimistic.values()]
    .filter((entry) => now - entry.sentAt < QUEUE_FLASH_SUPPRESS_MS)

  if (suppressiblePrompts.length === 0) return queuedPrompts

  return queuedPrompts.filter((entry) => {
    const matchIndex = suppressiblePrompts.findIndex((pending) => queuedPromptMatchesPending(entry, pending))
    if (matchIndex === -1) return true
    suppressiblePrompts.splice(matchIndex, 1)
    return false
  })
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
  const queuedPromptsRef = useRef<PromptQueueEntry[]>([])
  const [queueVisibilityNow, setQueueVisibilityNow] = useState(() => Date.now())
  const [taskStatus, setTaskStatus] = useState<TaskStatus | null>(null)
  const [contextTokens, setContextTokens] = useState(initialContextTokens ?? 0)
  const [contextWindowMax, setContextWindowMax] = useState<number | null>(initialContextWindowMax ?? null)
  const [configOptions, setConfigOptions] = useState<AgentConfigOption[]>([])
  const [slashCommands, setSlashCommands] = useState<AgentSlashCommand[]>([])
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const { connected, messages: wsMessages, send } = useWebSocket(taskId)
  const activeTaskIdRef = useRef(taskId)
  activeTaskIdRef.current = taskId
  const processedCountRef = useRef(0)
  const activeAssistantStreamIdRef = useRef<string | null>(null)
  // Track optimistic user messages so WS broadcasts dedupe without hiding
  // real queued messages forever when the server briefly queues an idle send.
  const pendingOptimisticRef = useRef<Map<string, PendingOptimisticPrompt>>(new Map())

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
    queuedPromptsRef.current = []
    setTaskStatus(null)
    setContextTokens(0)
    setContextWindowMax(null)
    setConfigOptions([])
    setSlashCommands([])
    setHasMoreMessages(false)
    setLoadingOlderMessages(false)
    processedCountRef.current = 0
    activeAssistantStreamIdRef.current = null
    for (const pending of pendingOptimisticRef.current.values()) clearPendingOptimistic(pending)
    pendingOptimisticRef.current.clear()
    setQueueVisibilityNow(Date.now())
  }, [taskId])

  useEffect(() => {
    return () => {
      for (const pending of pendingOptimisticRef.current.values()) clearPendingOptimistic(pending)
      pendingOptimisticRef.current.clear()
    }
  }, [])

  // Clear stale stream ID when disconnected to prevent corrupted messages on reconnect
  useEffect(() => {
    if (!connected) {
      activeAssistantStreamIdRef.current = null
    }
  }, [connected])

  function clearPendingOptimistic(pending: PendingOptimisticPrompt): void {
    clearTimeout(pending.revealTimer)
    clearTimeout(pending.cleanupTimer)
  }

  function applyQueuedPrompts(next: PromptQueueEntry[]): void {
    queuedPromptsRef.current = next
    setQueuedPrompts(next)
    removeOptimisticMessagesForVisibleQueue(Date.now())
  }

  function removeOptimisticMessagesForVisibleQueue(now: number): void {
    const visibleQueued = filterVisibleQueuedPrompts(queuedPromptsRef.current, pendingOptimisticRef.current, now)
    const unmatchedVisibleQueued = [...visibleQueued]
    const optimisticIdsToRemove: string[] = []

    for (const [optimisticId, pending] of pendingOptimisticRef.current) {
      const matchIndex = unmatchedVisibleQueued.findIndex((entry) => queuedPromptMatchesPending(entry, pending))
      if (matchIndex === -1) continue
      optimisticIdsToRemove.push(optimisticId)
      unmatchedVisibleQueued.splice(matchIndex, 1)
    }

    if (optimisticIdsToRemove.length > 0) {
      for (const optimisticId of optimisticIdsToRemove) {
        const pending = pendingOptimisticRef.current.get(optimisticId)
        if (pending) clearPendingOptimistic(pending)
        pendingOptimisticRef.current.delete(optimisticId)
      }
      setMessages((prev) => prev.filter((message) => !optimisticIdsToRemove.includes(message.id)))
    }

    setQueueVisibilityNow(now)
  }

  const INITIAL_MESSAGE_LIMIT = 100

  function logToMessage(log: SessionLog, taskIdForImages: string): ChatMessage {
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
        msg.images = filenames.map((f) => ({ src: `/api/tasks/${taskIdForImages}/images/${f}` }))
      } catch { /* ignore malformed */ }
    }
    return msg
  }

  // Load initial messages + activities via REST (parallelized for faster task switching)
  const refreshFromRest = useCallback(async () => {
    const refreshTaskId = taskId
    const isCurrentTask = () => activeTaskIdRef.current === refreshTaskId
    const messagesRequestedAtMs = Date.now()

    // Fire all independent requests in parallel (fetch most recent N messages for fast initial load)
    const [messagesResult, activitiesResult, optionsResult, commandsResult, queuedResult] = await Promise.all([
      fetchMessagesPaginated(refreshTaskId, INITIAL_MESSAGE_LIMIT).catch(() => null),
      fetchActivities(refreshTaskId).catch(() => null),
      fetchTaskConfigOptions(refreshTaskId).catch(() => null),
      fetchTaskSlashCommands(refreshTaskId).catch(() => null),
      fetchQueuedPrompts(refreshTaskId).catch(() => null),
    ])

    if (!isCurrentTask()) return

    // Apply messages
    if (messagesResult) {
      const snapshot = messagesResult.messages.map((log) => logToMessage(log, refreshTaskId))
      setMessages((prev) => mergeMessageSnapshot(prev, snapshot, messagesRequestedAtMs))
      setHasMoreMessages(messagesResult.hasMore)
    }

    // Apply activities
    if (activitiesResult) {
      setActivities((prev) => mergeActivitySnapshot(prev, activitiesResult))
    }

    // Apply config options
    if (optionsResult) {
      setConfigOptions(optionsResult)
    }

    // Apply slash commands
    if (commandsResult) {
      setSlashCommands(commandsResult)
    }

    // Apply queued prompts
    if (queuedResult) {
      applyQueuedPrompts(queuedResult)
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
          const currentStreamId = activeAssistantStreamIdRef.current
          // Reuse existing stream ID only if: (1) no messageId (continuation), or (2) messageId matches current stream
          const shouldReuseStreamId = currentStreamId && (!messageId || currentStreamId === `assistant-${messageId}`)
          const id = shouldReuseStreamId ? currentStreamId : (messageId ? `assistant-${messageId}` : `assistant-active-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
          // Prioritize existing stream ID to match streaming message, fall back to messageId
          const streamId = activeAssistantStreamIdRef.current ?? (messageId ? `assistant-${messageId}` : null)
          if (newMsg.role === "assistant") {
            activeAssistantStreamIdRef.current = null
            setMessages((prev) => {
              // If we have a streamId, replace that message
              if (streamId) {
                return applyAssistantStreamMessage(prev, {
                  content: newMsg.content,
                  timestamp: newMsg.timestamp,
                  images: newMsg.images,
                }, streamId, "complete")
              }
              // Fallback: find recent incomplete streaming message (assistant-active-*) and replace it
              const fallbackMsg = [...prev].reverse().find((m) => m.role === "assistant" && m.id.startsWith("assistant-active-"))
              if (fallbackMsg) {
                return applyAssistantStreamMessage(prev, {
                  content: newMsg.content,
                  timestamp: newMsg.timestamp,
                  images: newMsg.images,
                }, fallbackMsg.id, "complete")
              }
              // No streaming message found, add as new
              return [...prev, newMsg]
            })
            break
          }
          setMessages((prev) => {
            // Deduplicate: if this tab sent the message optimistically, skip
            // the WS broadcast. Match by content against pending optimistic IDs
            // so sending the same text twice still works correctly.
            // Mark as acknowledged (don't delete) so queue handler can check later.
            // Only match unacknowledged entries to avoid matching stale ones.
            if (newMsg.role === "user" && pendingOptimisticRef.current.size > 0) {
              const matchId = [...pendingOptimisticRef.current.entries()].find(([, pending]) => {
                if (pending.acknowledged) return false
                return pending.content === newMsg.content
              })?.[0]
              if (matchId) {
                const pending = pendingOptimisticRef.current.get(matchId)
                if (pending) pending.acknowledged = true
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
        // Suppress short idle-send queue flashes, then move persistent queued
        // prompts out of chat so the same text is not shown twice.
        applyQueuedPrompts(msg.queuedPrompts)
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
        const now = Date.now()
        const optimisticId = `user-${now}`
        const optimisticImages = clonePromptImages(images)
        const revealTimer = setTimeout(() => {
          removeOptimisticMessagesForVisibleQueue(Date.now())
        }, QUEUE_FLASH_SUPPRESS_MS)
        const cleanupTimer = setTimeout(() => {
          pendingOptimisticRef.current.delete(optimisticId)
          setQueueVisibilityNow(Date.now())
        }, QUEUE_OPTIMISTIC_TTL_MS)
        pendingOptimisticRef.current.set(optimisticId, { acknowledged: false, content: text, images: optimisticImages, sentAt: now, revealTimer, cleanupTimer })
        setQueueVisibilityNow(now)
        setMessages((prev) => [
          ...prev,
          {
            id: optimisticId,
            role: "user",
            content: text,
            timestamp: new Date(now).toISOString(),
            images: optimisticImages?.map((img) => ({ src: `data:${img.mediaType};base64,${img.data}` })),
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
    setQueuedPrompts((prev) => {
      const next = prev.map((entry) => entry.id === promptId ? updated : entry)
      queuedPromptsRef.current = next
      return next
    })
  }, [taskId])

  const handleRemoveQueuedPrompt = useCallback(async (promptId: string) => {
    await removeQueuedPrompt(taskId, promptId)
    setQueuedPrompts((prev) => {
      const next = prev.filter((entry) => entry.id !== promptId)
      queuedPromptsRef.current = next
      return next
    })
  }, [taskId])

  const handleClearAllQueuedPrompts = useCallback(async () => {
    const idsToRemove = queuedPromptsRef.current.map((entry) => entry.id)
    await Promise.all(idsToRemove.map((id) => removeQueuedPrompt(taskId, id)))
    setQueuedPrompts([])
    queuedPromptsRef.current = []
  }, [taskId])

  const handleSendNowQueuedPrompt = useCallback(async (promptId: string) => {
    const entry = queuedPromptsRef.current.find((e) => e.id === promptId)
    if (!entry) return
    await removeQueuedPrompt(taskId, promptId)
    setQueuedPrompts((prev) => {
      const next = prev.filter((e) => e.id !== promptId)
      queuedPromptsRef.current = next
      return next
    })
    sendPrompt(entry.text, entry.images)
  }, [taskId, sendPrompt])

  const visibleQueuedPrompts = filterVisibleQueuedPrompts(queuedPrompts, pendingOptimisticRef.current, queueVisibilityNow)

  const loadOlderMessages = useCallback(async () => {
    if (!hasMoreMessages || loadingOlderMessages) return
    setLoadingOlderMessages(true)
    try {
      // Find oldest non-transient message ID as cursor
      const oldestId = messages.find((m) => !m.id.startsWith("user-") && !m.id.startsWith("assistant-") && !m.id.startsWith("thinking-"))?.id
      const beforeId = oldestId ? parseInt(oldestId, 10) : undefined
      if (!beforeId || isNaN(beforeId)) {
        setHasMoreMessages(false)
        return
      }
      const result = await fetchMessagesPaginated(taskId, INITIAL_MESSAGE_LIMIT, beforeId)
      if (activeTaskIdRef.current !== taskId) return
      const olderMessages = result.messages.map((log) => logToMessage(log, taskId))
      setMessages((prev) => [...olderMessages, ...prev])
      setHasMoreMessages(result.hasMore)
    } catch {
      // ignore
    } finally {
      setLoadingOlderMessages(false)
    }
  }, [taskId, messages, hasMoreMessages, loadingOlderMessages])

  return { messages, activities, agentStatus, queueLength: visibleQueuedPrompts.length, queuedPrompts: visibleQueuedPrompts, connected, taskStatus, sendPrompt, abort, updateQueuedPrompt: handleUpdateQueuedPrompt, removeQueuedPrompt: handleRemoveQueuedPrompt, clearAllQueuedPrompts: handleClearAllQueuedPrompts, sendNowQueuedPrompt: handleSendNowQueuedPrompt, contextTokens, contextWindowMax, configOptions, slashCommands, hasMoreMessages, loadingOlderMessages, loadOlderMessages }
}
