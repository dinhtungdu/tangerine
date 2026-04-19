// Singleton event emitter for task events.
// WebSocket routes subscribe per-task; the task manager emits on status transitions.

type TaskEventHandler = (data: unknown) => void
type StatusChangeHandler = (status: string) => void

const taskEventListeners = new Map<string, Set<TaskEventHandler>>()
const statusChangeListeners = new Map<string, Set<StatusChangeHandler>>()

// Track whether each task's agent is currently working or idle.
// This is separate from task status ("running" = task is open, agent may be idle).
const agentWorkingState = new Map<string, "idle" | "working">()

// Global listeners for agent_status broadcasts (used by task-list WS)
type AgentStatusHandler = (event: { taskId: string; agentStatus: "idle" | "working" }) => void
const agentStatusListeners = new Set<AgentStatusHandler>()

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

/** Update the agent working state for a task and broadcast to global listeners. */
export function setAgentWorkingState(taskId: string, state: "idle" | "working"): void {
  agentWorkingState.set(taskId, state)
  for (const handler of agentStatusListeners) {
    handler({ taskId, agentStatus: state })
  }
}

/** Clean up agent working state when a task is terminal. */
export function clearAgentWorkingState(taskId: string): void {
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

/** Subscribe to global agent_status events (all tasks). Returns unsubscribe function. */
export function onAgentStatusChange(handler: AgentStatusHandler): () => void {
  agentStatusListeners.add(handler)
  return () => { agentStatusListeners.delete(handler) }
}
