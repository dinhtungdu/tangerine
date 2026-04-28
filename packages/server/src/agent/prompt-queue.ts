// Prompt queue: buffers user messages while the agent is busy.
// Wrapped in Effect so queue operations compose with the rest of the
// Effect-based agent pipeline and prompt-send failures are typed.

import { Effect } from "effect"
import { createLogger, truncate } from "../logger"
import { PromptError } from "../errors"
import { transientSchedule } from "../tasks/retry"
import type { PromptImage } from "./provider"

const log = createLogger("prompt-queue")

type AgentState = "idle" | "busy"

export interface PromptQueueEntry {
  id: string
  text: string
  images?: PromptImage[]
  fromTaskId?: string
  enqueuedAt: number
}

interface TaskQueue {
  entries: PromptQueueEntry[]
  state: AgentState
}

type QueueListener = (entries: PromptQueueEntry[]) => void

const queues = new Map<string, TaskQueue>()
const queueListeners = new Map<string, Set<QueueListener>>()

function getQueue(taskId: string): TaskQueue {
  let q = queues.get(taskId)
  if (!q) {
    q = { entries: [], state: "idle" }
    queues.set(taskId, q)
  }
  return q
}

export type SendPromptFn = (taskId: string, text: string, images?: PromptImage[], fromTaskId?: string) => Promise<void>

function cloneEntry(entry: PromptQueueEntry): PromptQueueEntry {
  return {
    ...entry,
    ...(entry.images ? { images: entry.images.map((image) => ({ ...image })) } : {}),
  }
}

function queueSnapshot(taskId: string): PromptQueueEntry[] {
  const q = queues.get(taskId)
  return q ? q.entries.map(cloneEntry) : []
}

function notifyQueueChanged(taskId: string): void {
  const listeners = queueListeners.get(taskId)
  if (!listeners || listeners.size === 0) return
  const snapshot = queueSnapshot(taskId)
  for (const listener of listeners) listener(snapshot)
}

export function onQueueChange(taskId: string, listener: QueueListener): () => void {
  let listeners = queueListeners.get(taskId)
  if (!listeners) {
    listeners = new Set()
    queueListeners.set(taskId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) queueListeners.delete(taskId)
  }
}

export function enqueue(taskId: string, text: string, images?: PromptImage[], fromTaskId?: string): Effect.Effect<PromptQueueEntry, never> {
  return Effect.sync(() => {
    const q = getQueue(taskId)
    const entry: PromptQueueEntry = { id: crypto.randomUUID(), text, images, fromTaskId, enqueuedAt: Date.now() }
    q.entries.push(entry)
    log.debug("Prompt enqueued", { taskId, queueLength: q.entries.length, promptId: entry.id })
    notifyQueueChanged(taskId)
    return cloneEntry(entry)
  })
}

export function getQueuedPrompts(taskId: string): Effect.Effect<PromptQueueEntry[], never> {
  return Effect.sync(() => queueSnapshot(taskId))
}

export function editQueuedPrompt(taskId: string, promptId: string, update: { text?: string; images?: PromptImage[]; fromTaskId?: string | null }): Effect.Effect<PromptQueueEntry | null, never> {
  return Effect.sync(() => {
    const q = queues.get(taskId)
    const entry = q?.entries.find((item) => item.id === promptId)
    if (!entry) return null
    if (update.text !== undefined) entry.text = update.text
    if (update.images !== undefined) entry.images = update.images
    if (update.fromTaskId !== undefined) {
      if (update.fromTaskId === null) delete entry.fromTaskId
      else entry.fromTaskId = update.fromTaskId
    }
    notifyQueueChanged(taskId)
    return cloneEntry(entry)
  })
}

export function removeQueuedPrompt(taskId: string, promptId: string): Effect.Effect<boolean, never> {
  return Effect.sync(() => {
    const q = queues.get(taskId)
    if (!q) return false
    const before = q.entries.length
    q.entries = q.entries.filter((entry) => entry.id !== promptId)
    const removed = q.entries.length !== before
    if (removed) notifyQueueChanged(taskId)
    return removed
  })
}

export function setAgentState(taskId: string, state: AgentState): Effect.Effect<void, never> {
  return Effect.sync(() => {
    const q = getQueue(taskId)
    const prev = q.state
    q.state = state
    if (prev !== state) {
      log.debug("Agent state changed", { taskId, state, previousState: prev })
    }
  })
}

/**
 * Dequeues and sends the next prompt if the agent is idle and the queue
 * is non-empty. Re-queues the prompt at the front on failure so no
 * messages are lost.
 */
export function drainNext(
  taskId: string,
  sendPrompt: SendPromptFn,
): Effect.Effect<boolean, PromptError> {
  return Effect.gen(function* () {
    const q = getQueue(taskId)
    if (q.state !== "idle" || q.entries.length === 0) return false

    const entry = q.entries.shift()!
    q.state = "busy"
    notifyQueueChanged(taskId)

    log.info("Sending next prompt", {
      taskId,
      promptPreview: truncate(entry.text, 80),
      waitedMs: Date.now() - entry.enqueuedAt,
    })

    // Retry transient failures (e.g. HTTP 503, stdin backpressure) with short
    // exponential backoff before re-queuing the prompt for a later drain cycle.
    yield* Effect.tryPromise({
      try: () => sendPrompt(taskId, entry.text, entry.images, entry.fromTaskId),
      catch: (e) => new PromptError({
        message: `Prompt send attempt failed: ${e instanceof Error ? e.message : String(e)}`,
        taskId,
        cause: e,
      }),
    }).pipe(
      Effect.retry(transientSchedule()),
      Effect.catchAll((e) => {
        // All retries exhausted — put it back at the front so no prompts are lost
        q.entries.unshift(entry)
        q.state = "idle"
        notifyQueueChanged(taskId)
        log.error("Prompt send failed after retries, re-queued", {
          taskId,
          error: e.message,
        })
        return Effect.fail(new PromptError({
          message: "Failed to send prompt after retries",
          taskId,
          cause: e,
        }))
      }),
    )

    return true
  })
}

/**
 * Drain all queued entries sequentially. Unlike drainNext, this ignores
 * the idle/busy state machine — use when the agent just became ready
 * and you want to flush everything that accumulated during startup.
 */
export function drainAll(
  taskId: string,
  sendPrompt: SendPromptFn,
): Effect.Effect<number, never> {
  return Effect.gen(function* () {
    const q = getQueue(taskId)
    const entries = q.entries.splice(0)
    if (entries.length === 0) return 0
    notifyQueueChanged(taskId)

    log.info("Draining all queued prompts", { taskId, count: entries.length })
    let sent = 0
    for (const entry of entries) {
      yield* Effect.tryPromise({
        try: () => sendPrompt(taskId, entry.text, entry.images, entry.fromTaskId),
        catch: () => new PromptError({
          message: "Drain send failed",
          taskId,
        }),
      }).pipe(
        Effect.retry(transientSchedule()),
        Effect.catchAll((e) => {
          log.error("Failed to drain queued prompt, discarding", {
            taskId,
            error: e.message,
            promptPreview: truncate(entry.text, 80),
          })
          return Effect.void
        }),
      )
      sent++
    }
    return sent
  })
}

export function getQueueLength(taskId: string): Effect.Effect<number, never> {
  return Effect.sync(() => {
    const q = queues.get(taskId)
    return q ? q.entries.length : 0
  })
}

export function getAgentState(taskId: string): Effect.Effect<AgentState, never> {
  return Effect.sync(() => {
    const q = queues.get(taskId)
    return q ? q.state : "idle"
  })
}

export function clearQueue(taskId: string): Effect.Effect<void, never> {
  return Effect.sync(() => {
    queues.delete(taskId)
    notifyQueueChanged(taskId)
  })
}
