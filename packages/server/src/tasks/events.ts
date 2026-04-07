// Singleton event emitter for task events.
// WebSocket routes subscribe per-task; the task manager emits on status transitions.

import { DEFAULT_IDLE_TIMEOUT_MS } from "@tangerine/shared"

type TaskEventHandler = (data: unknown) => void
type StatusChangeHandler = (status: string) => void

const taskEventListeners = new Map<string, Set<TaskEventHandler>>()
const statusChangeListeners = new Map<string, Set<StatusChangeHandler>>()

// Track whether each task's agent is currently working or idle.
// This is separate from task status ("running" = task is open, agent may be idle).
const agentWorkingState = new Map<string, "idle" | "working">()

// Timestamp when each task's agent last went idle. Used to compute display state:
// the UI shows "working" for IDLE_GRACE_MS after going idle so it doesn't flash
// idle immediately after a response. The raw working state stays accurate for
// health checks (isAgentWorking / suspension logic).
const agentIdleSince = new Map<string, number>()
const IDLE_GRACE_MS = DEFAULT_IDLE_TIMEOUT_MS

export function emitTaskEvent(taskId: string, data: unknown): void {
  const handlers = taskEventListeners.get(taskId)
  if (!handlers) return
  for (const handler of handlers) {
    handler(data)
  }
}

export function emitStatusChange(taskId: string, status: string): void {
  const handlers = statusChangeListeners.get(taskId)
  if (!handlers) return
  for (const handler of handlers) {
    handler(status)
  }
}

/** Subscribe to task events. Returns an unsubscribe function. */
export function onTaskEvent(taskId: string, handler: TaskEventHandler): () => void {
  let handlers = taskEventListeners.get(taskId)
  if (!handlers) {
    handlers = new Set()
    taskEventListeners.set(taskId, handlers)
  }
  handlers.add(handler)

  return () => {
    handlers.delete(handler)
    if (handlers.size === 0) {
      taskEventListeners.delete(taskId)
    }
  }
}

/** Get the raw agent working state (accurate, used for health checks / suspension). */
export function getAgentWorkingState(taskId: string): "idle" | "working" {
  return agentWorkingState.get(taskId) ?? "idle"
}

/**
 * Get the display state for the UI. Returns "working" for IDLE_GRACE_MS after
 * the agent goes idle so the sidebar doesn't flash idle right after a response.
 */
export function getAgentDisplayState(taskId: string): "idle" | "working" {
  const state = agentWorkingState.get(taskId) ?? "idle"
  if (state === "idle") {
    const idleSince = agentIdleSince.get(taskId)
    if (idleSince !== undefined && Date.now() - idleSince < IDLE_GRACE_MS) {
      return "working"
    }
  }
  return state
}

/** Check if an agent working state has been explicitly set for a task. */
export function hasAgentWorkingState(taskId: string): boolean {
  return agentWorkingState.has(taskId)
}

/** Update the agent working state for a task. */
export function setAgentWorkingState(taskId: string, state: "idle" | "working"): void {
  if (state === "idle") {
    agentIdleSince.set(taskId, Date.now())
  } else {
    agentIdleSince.delete(taskId)
  }
  agentWorkingState.set(taskId, state)
}

/** Clean up agent working state when a task is terminal. */
export function clearAgentWorkingState(taskId: string): void {
  agentWorkingState.delete(taskId)
  agentIdleSince.delete(taskId)
}

/** Subscribe to status changes. Returns an unsubscribe function. */
export function onStatusChange(taskId: string, handler: StatusChangeHandler): () => void {
  let handlers = statusChangeListeners.get(taskId)
  if (!handlers) {
    handlers = new Set()
    statusChangeListeners.set(taskId, handlers)
  }
  handlers.add(handler)

  return () => {
    handlers.delete(handler)
    if (handlers.size === 0) {
      statusChangeListeners.delete(taskId)
    }
  }
}
