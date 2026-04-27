// Consolidated per-task in-memory coordination state.
// Replaces scattered Set/Map instances across start.ts and health.ts.

import type { AgentConfigOption } from "@tangerine/shared"

/** Per-task coordination state tracked in memory (not persisted). */
export interface TaskState {
  reconnecting: boolean
  suspended: boolean
  idleWake: boolean
  lastError?: string
  firstPromptSent: boolean
  systemPromptApplied: boolean
  prUrlSaved: boolean
  prNudgeSent: boolean
  prNudgeTimer?: Timer
  consecutiveRestarts: number
  /** Timestamp (ms) when we last aborted the agent for a hung tool. Used to
   *  apply a cooldown so we don't re-abort immediately after restart when the
   *  old tool.start entry is still the most recent activity in the DB. */
  hungToolAbortedAt?: number
  /** Current context window usage (persisted to DB, displayed as used/max) */
  contextTokens: number
  /** Active ACP session configuration selectors. */
  configOptions: AgentConfigOption[]
  /** Latest ACP session metadata update. */
  sessionInfo: { title?: string | null; updatedAt?: string | null; metadata?: Record<string, unknown> }
}

const taskStates = new Map<string, TaskState>()

function defaultState(): TaskState {
  return {
    reconnecting: false,
    suspended: false,
    idleWake: false,
    firstPromptSent: false,
    systemPromptApplied: false,
    prUrlSaved: false,
    prNudgeSent: false,
    consecutiveRestarts: 0,
    contextTokens: 0,
    configOptions: [],
    sessionInfo: {},
  }
}

/** Get or initialize task state. Creates default state on first access. */
export function getTaskState(taskId: string): TaskState {
  let state = taskStates.get(taskId)
  if (!state) {
    state = defaultState()
    taskStates.set(taskId, state)
  }
  return state
}

/** Remove all in-memory state for a task (call on termination/completion). */
export function clearTaskState(taskId: string): void {
  const state = taskStates.get(taskId)
  if (state?.prNudgeTimer) {
    clearTimeout(state.prNudgeTimer)
  }
  taskStates.delete(taskId)
}
