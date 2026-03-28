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

interface QueueEntry {
  text: string
  images?: PromptImage[]
  enqueuedAt: number
}

interface TaskQueue {
  entries: QueueEntry[]
  state: AgentState
}

const queues = new Map<string, TaskQueue>()

function getQueue(taskId: string): TaskQueue {
  let q = queues.get(taskId)
  if (!q) {
    q = { entries: [], state: "idle" }
    queues.set(taskId, q)
  }
  return q
}

export type SendPromptFn = (taskId: string, text: string, images?: PromptImage[]) => Promise<void>

export function enqueue(taskId: string, text: string, images?: PromptImage[]): Effect.Effect<number, never> {
  return Effect.sync(() => {
    const q = getQueue(taskId)
    q.entries.push({ text, images, enqueuedAt: Date.now() })
    log.debug("Prompt enqueued", { taskId, queueLength: q.entries.length })
    return q.entries.length
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

    log.info("Sending next prompt", {
      taskId,
      promptPreview: truncate(entry.text, 80),
      waitedMs: Date.now() - entry.enqueuedAt,
    })

    // Retry transient failures (e.g. HTTP 503, stdin backpressure) with short
    // exponential backoff before re-queuing the prompt for a later drain cycle.
    yield* Effect.tryPromise({
      try: () => sendPrompt(taskId, entry.text, entry.images),
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
  })
}
