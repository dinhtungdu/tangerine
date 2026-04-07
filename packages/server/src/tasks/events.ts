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

// Delay before flipping to idle — matches the suspension timeout so "idle" means
// "dormant long enough to be suspended", not just "finished the current turn".
const IDLE_GRACE_MS = DEFAULT_IDLE_TIMEOUT_MS
const idleGraceTimers = new Map<string, ReturnType<typeof setTimeout>>()

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

/** Get the current agent working state for a task. */
export function getAgentWorkingState(taskId: string): "idle" | "working" {
  return agentWorkingState.get(taskId) ?? "idle"
}

/** Check if an agent working state has been explicitly set for a task. */
export function hasAgentWorkingState(taskId: string): boolean {
  return agentWorkingState.has(taskId)
}

/** Update the agent working state for a task. */
export function setAgentWorkingState(taskId: string, state: "idle" | "working"): void {
  // Always cancel any pending idle grace timer first
  const existing = idleGraceTimers.get(taskId)
  if (existing) { clearTimeout(existing); idleGraceTimers.delete(taskId) }

  if (state === "working") {
    agentWorkingState.set(taskId, "working")
  } else {
    // Delay the idle flip so the UI doesn't immediately show idle after a response
    idleGraceTimers.set(taskId, setTimeout(() => {
      agentWorkingState.set(taskId, "idle")
      idleGraceTimers.delete(taskId)
    }, IDLE_GRACE_MS))
    // Leave the map at its current value ("working") during the grace period
  }
}

/** Clean up agent working state when a task is terminal. */
export function clearAgentWorkingState(taskId: string): void {
  const timer = idleGraceTimers.get(taskId)
  if (timer) { clearTimeout(timer); idleGraceTimers.delete(taskId) }
  agentWorkingState.delete(taskId)
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
