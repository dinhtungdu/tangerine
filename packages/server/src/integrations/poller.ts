// Generic polling loop using Effect.repeat with Schedule.
// Non-overlapping: each poll completes before the next delay starts.
// Errors are logged but never crash the poller — it runs until stopped.

import { Effect, Fiber, Schedule } from "effect"

export class Poller {
  private fiber: Fiber.RuntimeFiber<void, never> | null = null
  private readonly intervalMs: number
  private readonly pollFn: Effect.Effect<void, never>

  constructor(intervalMs: number, pollFn: Effect.Effect<void, never>) {
    this.intervalMs = intervalMs
    this.pollFn = pollFn
  }

  start(): Effect.Effect<void, never> {
    const self = this
    return Effect.gen(function* () {
      if (self.fiber) return

      self.fiber = yield* self.pollFn.pipe(
        Effect.repeat(Schedule.spaced(`${self.intervalMs} millis`)),
        Effect.catchAll(() => Effect.void),
        Effect.asVoid,
        Effect.forkDaemon,
      )
    })
  }

  stop(): Effect.Effect<void, never> {
    if (!this.fiber) return Effect.void
    const f = this.fiber
    this.fiber = null
    return Fiber.interrupt(f).pipe(Effect.asVoid)
  }
}
