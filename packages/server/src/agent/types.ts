/** State of the OpenCode agent for a given task */
export type AgentState = "idle" | "working"

/** Callback for receiving OpenCode SSE events */
export type EventListener = (event: OpenCodeEvent) => void

/** Parsed event from OpenCode's SSE stream */
export interface OpenCodeEvent {
  type: string
  data: Record<string, unknown>
}

/** Tracks an active SSE subscription for a task */
export interface EventSubscription {
  taskId: string
  abort: AbortController
  listeners: Set<EventListener>
  retryCount: number
}

/** Entry in the per-task prompt queue */
export interface QueuedPrompt {
  text: string
  enqueuedAt: number
}
