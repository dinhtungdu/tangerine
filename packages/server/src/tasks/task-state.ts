// Consolidated per-task in-memory coordination state.
// Replaces scattered Set/Map instances across start.ts and health.ts.

import type { AgentConfigOption } from "@tangerine/shared"

export interface ActiveStreamMessage {
  role: "assistant" | "thinking"
  content: string
  messageId: string
  timestamp: string
}

/** Per-task coordination state tracked in memory (not persisted). */
export interface TaskState {
  reconnecting: boolean
  suspended: boolean
  idleWake: boolean
  queuePaused: boolean
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
  /** Current context window capacity when ACP reports it. */
  contextWindowMax: number | null
  /** Active ACP session configuration selectors. */
  configOptions: AgentConfigOption[]
  /** Latest ACP session metadata update. */
  sessionInfo: { title?: string | null; updatedAt?: string | null; metadata?: Record<string, unknown> }
  /** In-memory stream snapshots used when a browser switches into a running task mid-turn. */
  activeAssistantMessage?: ActiveStreamMessage
  activeThinkingMessage?: ActiveStreamMessage
}

const taskStates = new Map<string, TaskState>()

function defaultState(): TaskState {
  return {
    reconnecting: false,
    suspended: false,
    idleWake: false,
    queuePaused: false,
    firstPromptSent: false,
    systemPromptApplied: false,
    prUrlSaved: false,
    prNudgeSent: false,
    consecutiveRestarts: 0,
    contextTokens: 0,
    contextWindowMax: null,
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

function activeField(role: ActiveStreamMessage["role"]): "activeAssistantMessage" | "activeThinkingMessage" {
  return role === "assistant" ? "activeAssistantMessage" : "activeThinkingMessage"
}

function createSyntheticMessageId(): string {
  return `active-${crypto.randomUUID()}`
}

export function appendActiveStreamMessage(
  taskId: string,
  role: ActiveStreamMessage["role"],
  content: string,
  messageId?: string,
): ActiveStreamMessage {
  const state = getTaskState(taskId)
  const field = activeField(role)
  const existing = state[field]
  const resolvedMessageId = existing?.messageId ?? messageId ?? createSyntheticMessageId()
  const next: ActiveStreamMessage = existing
    ? { ...existing, content: `${existing.content}${content}` }
    : { role, content, messageId: resolvedMessageId, timestamp: new Date().toISOString() }
  state[field] = next
  return next
}

export function completeActiveStreamMessage(
  taskId: string,
  role: ActiveStreamMessage["role"],
): ActiveStreamMessage | undefined {
  const state = getTaskState(taskId)
  const field = activeField(role)
  const existing = state[field]
  state[field] = undefined
  return existing
}

export function getActiveStreamMessages(taskId: string): ActiveStreamMessage[] {
  const state = getTaskState(taskId)
  return [state.activeThinkingMessage, state.activeAssistantMessage]
    .filter((message): message is ActiveStreamMessage => Boolean(message?.content))
}

/** Remove all in-memory state for a task (call on termination/completion). */
export function clearTaskState(taskId: string): void {
  const state = taskStates.get(taskId)
  if (state?.prNudgeTimer) {
    clearTimeout(state.prNudgeTimer)
  }
  taskStates.delete(taskId)
}
