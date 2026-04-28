import { describe, it, expect, beforeEach, mock } from "bun:test"
import { Effect } from "effect"
import {
  enqueue,
  setAgentState,
  drainNext,
  clearQueue,
  editQueuedPrompt,
  getQueuedPrompts,
  onQueueChange,
  removeQueuedPrompt,
  type SendPromptFn,
} from "../agent/prompt-queue"

/**
 * Tracer bullet: Prompt enqueue -> Agent state tracking -> Delivery
 *
 * Tests the prompt queue that buffers follow-up prompts while the
 * agent is busy, and delivers them in order as the agent goes idle.
 */
describe("tracer: prompt queue -> agent state -> delivery", () => {
  const tid = () => `task-${crypto.randomUUID().slice(0, 8)}`
  let sentPrompts: Array<{ taskId: string; text: string; fromTaskId?: string; displayText?: string }>
  let sendPrompt: SendPromptFn

  beforeEach(() => {
    sentPrompts = []
    sendPrompt = mock(async (taskId: string, text: string, _images, fromTaskId, displayText) => {
      sentPrompts.push({ taskId, text, fromTaskId, displayText })
    }) as SendPromptFn
  })

  it("enqueues a prompt and drains when agent is idle", async () => {
    const t = tid()

    Effect.runSync(enqueue(t, "Hello agent"))

    // Agent is idle by default, drain should send
    const sent = await Effect.runPromise(drainNext(t, sendPrompt))
    expect(sent).toBe(true)
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]!.text).toBe("Hello agent")
    expect(sentPrompts[0]!.taskId).toBe(t)

    Effect.runSync(clearQueue(t))
  })

  it("does not drain when agent is busy", async () => {
    const t = tid()

    Effect.runSync(enqueue(t, "Queued message"))
    Effect.runSync(setAgentState(t, "busy"))

    const sent = await Effect.runPromise(drainNext(t, sendPrompt))
    expect(sent).toBe(false)
    expect(sentPrompts).toHaveLength(0)

    Effect.runSync(clearQueue(t))
  })

  it("drains queued prompt when agent transitions to idle", async () => {
    const t = tid()

    // Agent is busy, queue a prompt
    Effect.runSync(setAgentState(t, "busy"))
    Effect.runSync(enqueue(t, "Queued message"))

    // Nothing should drain while busy
    let sent = await Effect.runPromise(drainNext(t, sendPrompt))
    expect(sent).toBe(false)

    // Agent goes idle
    Effect.runSync(setAgentState(t, "idle"))
    sent = await Effect.runPromise(drainNext(t, sendPrompt))
    expect(sent).toBe(true)
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]!.text).toBe("Queued message")

    Effect.runSync(clearQueue(t))
  })

  it("delivers multiple prompts in FIFO order", async () => {
    const t = tid()

    Effect.runSync(enqueue(t, "First"))
    Effect.runSync(enqueue(t, "Second"))
    Effect.runSync(enqueue(t, "Third"))

    // Drain first
    await Effect.runPromise(drainNext(t, sendPrompt))
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]!.text).toBe("First")

    // After sending, agent is marked busy by drainNext.
    // Simulate agent finishing and going idle.
    Effect.runSync(setAgentState(t, "idle"))

    // Drain second
    await Effect.runPromise(drainNext(t, sendPrompt))
    expect(sentPrompts).toHaveLength(2)
    expect(sentPrompts[1]!.text).toBe("Second")

    Effect.runSync(setAgentState(t, "idle"))

    // Drain third
    await Effect.runPromise(drainNext(t, sendPrompt))
    expect(sentPrompts).toHaveLength(3)
    expect(sentPrompts[2]!.text).toBe("Third")

    // Queue should be empty now
    Effect.runSync(setAgentState(t, "idle"))
    const emptySend = await Effect.runPromise(drainNext(t, sendPrompt))
    expect(emptySend).toBe(false)

    Effect.runSync(clearQueue(t))
  })

  it("exposes stable queued prompt ids and snapshots", () => {
    const t = tid()
    const snapshots: string[][] = []
    const unsubscribe = onQueueChange(t, (entries) => snapshots.push(entries.map((entry) => entry.text)))

    const first = Effect.runSync(enqueue(t, "First", undefined, "source-task"))
    const second = Effect.runSync(enqueue(t, "Second"))

    expect(first.id).not.toBe(second.id)
    expect(first.fromTaskId).toBe("source-task")
    expect(Effect.runSync(getQueuedPrompts(t)).map((entry) => entry.text)).toEqual(["First", "Second"])
    expect(snapshots).toEqual([["First"], ["First", "Second"]])

    unsubscribe()
    Effect.runSync(clearQueue(t))
  })

  it("passes display text when draining prompts with system notes", async () => {
    const t = tid()
    Effect.runSync(enqueue(t, "system notes\n\nOriginal", undefined, "source-task", "Original"))

    await Effect.runPromise(drainNext(t, sendPrompt))

    expect(sentPrompts).toEqual([{ taskId: t, text: "system notes\n\nOriginal", fromTaskId: "source-task", displayText: "Original" }])

    Effect.runSync(clearQueue(t))
  })

  it("edits and removes queued prompts before delivery", async () => {
    const t = tid()
    const entry = Effect.runSync(enqueue(t, "Original", undefined, "source-task"))
    Effect.runSync(editQueuedPrompt(t, entry.id, { text: "Edited" }))

    expect(Effect.runSync(getQueuedPrompts(t))[0]?.text).toBe("Edited")

    await Effect.runPromise(drainNext(t, sendPrompt))
    expect(sentPrompts).toEqual([{ taskId: t, text: "Edited", fromTaskId: "source-task", displayText: "Edited" }])

    Effect.runSync(setAgentState(t, "idle"))
    const removedEntry = Effect.runSync(enqueue(t, "Remove me"))
    expect(Effect.runSync(removeQueuedPrompt(t, removedEntry.id))).toBe(true)
    expect(Effect.runSync(getQueuedPrompts(t))).toEqual([])

    Effect.runSync(clearQueue(t))
  })

  it("clearQueue removes all pending prompts", () => {
    const t = tid()

    Effect.runSync(setAgentState(t, "busy"))
    Effect.runSync(enqueue(t, "A"))
    Effect.runSync(enqueue(t, "B"))
    Effect.runSync(enqueue(t, "C"))

    Effect.runSync(clearQueue(t))

    // After clearing, nothing should drain
    Effect.runSync(setAgentState(t, "idle"))
    // drainNext needs to be called, but queue is cleared
  })

  it("clearQueue followed by drain returns false", async () => {
    const t = tid()

    Effect.runSync(enqueue(t, "Will be cleared"))
    Effect.runSync(clearQueue(t))

    const sent = await Effect.runPromise(drainNext(t, sendPrompt))
    expect(sent).toBe(false)
    expect(sentPrompts).toHaveLength(0)
  })

  it("re-queues prompt on send failure", async () => {
    const t = tid()
    const failingSend: SendPromptFn = async () => {
      throw new Error("Send failed")
    }

    Effect.runSync(enqueue(t, "Will fail"))

    // drainNext should throw when send fails (after transient retries are exhausted)
    await expect(Effect.runPromise(drainNext(t, failingSend))).rejects.toThrow("Failed to send prompt")

    // The prompt should be re-queued (put back at front)
    // Agent should be back to idle
    const retrySent = await Effect.runPromise(drainNext(t, sendPrompt))
    expect(retrySent).toBe(true)
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]!.text).toBe("Will fail")

    Effect.runSync(clearQueue(t))
  })

  it("drainNext sets agent state to busy", async () => {
    const t = tid()

    Effect.runSync(enqueue(t, "Test"))

    // First drain succeeds and sets state to busy
    await Effect.runPromise(drainNext(t, sendPrompt))
    expect(sentPrompts).toHaveLength(1)

    // Enqueue another, try to drain without setting idle
    Effect.runSync(enqueue(t, "Second"))
    const sent = await Effect.runPromise(drainNext(t, sendPrompt))
    // Should not drain because state is busy after first drain
    expect(sent).toBe(false)

    Effect.runSync(clearQueue(t))
  })

  it("separate tasks have independent queues", async () => {
    const t1 = tid()
    const t2 = tid()

    Effect.runSync(enqueue(t1, "For task 1"))
    Effect.runSync(enqueue(t2, "For task 2"))

    Effect.runSync(setAgentState(t1, "busy"))

    // Only t2 should drain (t1 is busy)
    const sent1 = await Effect.runPromise(drainNext(t1, sendPrompt))
    expect(sent1).toBe(false)

    const sent2 = await Effect.runPromise(drainNext(t2, sendPrompt))
    expect(sent2).toBe(true)

    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]!.taskId).toBe(t2)
    expect(sentPrompts[0]!.text).toBe("For task 2")

    Effect.runSync(clearQueue(t1))
    Effect.runSync(clearQueue(t2))
  })

  it("drains nothing from empty queue", async () => {
    const t = tid()

    const sent = await Effect.runPromise(drainNext(t, sendPrompt))
    expect(sent).toBe(false)
    expect(sentPrompts).toHaveLength(0)
  })
})
