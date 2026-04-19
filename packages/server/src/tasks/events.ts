// Singleton event emitter for task events.
// WebSocket routes subscribe per-task; the task manager emits on status transitions.

import type { TaskRow } from "../db/types"

type TaskEventHandler = (data: unknown) => void
type StatusChangeHandler = (status: string) => void

export type TaskListEvent =
  | { kind: "created"; task: TaskRow }
  | { kind: "updated"; task: TaskRow }
  | { kind: "deleted"; taskId: string; projectId: string }

type TaskListHandler = (event: TaskListEvent) => void

const taskEventListeners = new Map<string, Set<TaskEventHandler>>()
const statusChangeListeners = new Map<string, Set<StatusChangeHandler>>()
const taskListListeners = new Set<TaskListHandler>()

// Track whether each task's agent is currently working or idle.
// This is separate from task status ("running" = task is open, agent may be idle).
const agentWorkingState = new Map<string, "idle" | "working">()

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
  agentWorkingState.set(taskId, state)
}

/** Clean up agent working state when a task is terminal. */
export function clearAgentWorkingState(taskId: string): void {
  agentWorkingState.delete(taskId)
}

/** Emit a task-list level event (create/update/delete) to all listeners. */
export function emitTaskListEvent(event: TaskListEvent): void {
  for (const handler of taskListListeners) {
    try {
      handler(event)
    } catch {
      // Swallow listener errors — one broken subscriber should not break others.
    }
  }
}

/** Subscribe to task list events (create/update/delete across all tasks). */
export function onTaskListEvent(handler: TaskListHandler): () => void {
  taskListListeners.add(handler)
  return () => {
    taskListListeners.delete(handler)
  }
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
