// Singleton event emitter for task events.
// WebSocket routes subscribe per-task; the task manager emits on status transitions.

/**
 * If an agent claims "working" but hasn't produced output in this time,
 * treat it as stalled/idle. Matches Temporal's progress-based heartbeat model.
 */
export const AGENT_PROGRESS_TIMEOUT_MS = 120_000 // 2 minutes

type TaskEventHandler = (data: unknown) => void
type StatusChangeHandler = (status: string) => void

const taskEventListeners = new Map<string, Set<TaskEventHandler>>()
const statusChangeListeners = new Map<string, Set<StatusChangeHandler>>()

// Single state object per task: status + last progress timestamp (if working)
interface AgentState {
  status: "idle" | "working"
  lastProgressAt?: number // Updated on any output, not just turn start
}
const agentState = new Map<string, AgentState>()

// Global listeners for agent_status broadcasts (used by task-list WS)
type AgentStatusHandler = (event: { taskId: string; agentStatus: "idle" | "working" }) => void
const agentStatusListeners = new Set<AgentStatusHandler>()

type TaskListChange = { taskId: string; change: "created" | "updated" | "deleted" }
type TaskListChangeHandler = (event: TaskListChange) => void
const taskListChangeListeners = new Set<TaskListChangeHandler>()

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

/** Get the current agent working state for a task (pure, no side effects). */
export function getAgentWorkingState(taskId: string): "idle" | "working" {
  return agentState.get(taskId)?.status ?? "idle"
}

/** Check if an agent working state has been explicitly set for a task. */
export function hasAgentWorkingState(taskId: string): boolean {
  return agentState.has(taskId)
}

/**
 * Check if agent is stalled (working with no progress for > AGENT_PROGRESS_TIMEOUT_MS).
 * Returns true if stalled, false otherwise.
 */
export function isAgentStalled(taskId: string): boolean {
  const state = agentState.get(taskId)
  if (!state || state.status !== "working" || !state.lastProgressAt) return false
  return Date.now() - state.lastProgressAt >= AGENT_PROGRESS_TIMEOUT_MS
}

/**
 * Check for stalled agent and reset to idle if detected.
 * Call this before reading status in API routes and health checks.
 * Returns true if agent was stalled and reset.
 */
export function resetIfStalled(taskId: string): boolean {
  if (isAgentStalled(taskId)) {
    setAgentWorkingState(taskId, "idle")
    return true
  }
  return false
}

/**
 * Get effective agent status, resetting stalled agents first.
 * Convenience wrapper: resetIfStalled() + getAgentWorkingState().
 */
export function getEffectiveAgentStatus(taskId: string): "idle" | "working" {
  resetIfStalled(taskId)
  return getAgentWorkingState(taskId)
}

/** Update the agent working state for a task and broadcast to global listeners. */
export function setAgentWorkingState(taskId: string, status: "idle" | "working"): void {
  const state: AgentState = { status }
  if (status === "working") {
    state.lastProgressAt = Date.now()
  }
  agentState.set(taskId, state)
  for (const handler of agentStatusListeners) {
    handler({ taskId, agentStatus: status })
  }
}

/**
 * Record progress for a working agent. Call on any output (messages, tool use, thinking).
 * Resets stall timer so long-running but active agents aren't marked idle.
 */
export function recordAgentProgress(taskId: string): void {
  const state = agentState.get(taskId)
  if (state?.status === "working") {
    state.lastProgressAt = Date.now()
  }
}

/** Clean up agent working state when a task is terminal. */
export function clearAgentWorkingState(taskId: string): void {
  agentState.delete(taskId)
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

/** Broadcast list-visible task row mutations to global task-list listeners. */
export function emitTaskListChange(taskId: string, change: TaskListChange["change"]): void {
  for (const handler of taskListChangeListeners) {
    handler({ taskId, change })
  }
}

/** Subscribe to global task-list invalidation events. Returns an unsubscribe function. */
export function onTaskListChange(handler: TaskListChangeHandler): () => void {
  taskListChangeListeners.add(handler)
  return () => { taskListChangeListeners.delete(handler) }
}
