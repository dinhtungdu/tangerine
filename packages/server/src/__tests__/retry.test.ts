import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { exponentialSchedule, transientSchedule } from "../tasks/retry"

describe("retry schedules", () => {
  test("exponentialSchedule retries up to maxAttempts - 1 times", async () => {
    let attempts = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        attempts++
        if (attempts < 3) return yield* Effect.fail(new Error("boom"))
        return "ok"
      }).pipe(Effect.retry(exponentialSchedule(3)))
    )
    expect(result).toBe("ok")
    expect(attempts).toBe(3)
  })

  test("exponentialSchedule fails after maxAttempts", async () => {
    let attempts = 0
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          attempts++
          return yield* Effect.fail(new Error("permanent"))
        }).pipe(Effect.retry(exponentialSchedule(2)))
      )
    ).rejects.toThrow("permanent")
    expect(attempts).toBe(2)
  })

  test("transientSchedule retries with short backoff", async () => {
    let attempts = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        attempts++
        if (attempts < 2) return yield* Effect.fail(new Error("transient"))
        return "recovered"
      }).pipe(Effect.retry(transientSchedule()))
    )
    expect(result).toBe("recovered")
    expect(attempts).toBe(2)
  })

  test("transientSchedule fails after default 2 attempts", async () => {
    let attempts = 0
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          attempts++
          return yield* Effect.fail(new Error("permanent"))
        }).pipe(Effect.retry(transientSchedule()))
      )
    ).rejects.toThrow("permanent")
    // transientSchedule(2) → recurs(1) → 1 retry → 2 total attempts
    expect(attempts).toBe(2)
  })

  test("transientSchedule with custom maxAttempts", async () => {
    let attempts = 0
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          attempts++
          return yield* Effect.fail(new Error("fail"))
        }).pipe(Effect.retry(transientSchedule(3)))
      )
    ).rejects.toThrow("fail")
    expect(attempts).toBe(3) // transientSchedule(3) → recurs(2) → 2 retries → 3 total
  })
})
