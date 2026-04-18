import { describe, expect, test, mock } from "bun:test"
import { createHeartbeatMonitor } from "../lib/ws-heartbeat"

function createFakeTimeoutTimers() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { handler: () => void; at: number }>()

  return {
    timers: {
      setTimeout(handler: () => void, timeout: number) {
        const id = nextId++
        timers.set(id, { handler, at: now + timeout })
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout(timer: ReturnType<typeof setTimeout>) {
        timers.delete(timer as unknown as number)
      },
    },
    advance(ms: number) {
      now += ms
      let ran = true
      while (ran) {
        ran = false
        for (const [id, timer] of [...timers.entries()]) {
          if (timer.at > now) continue
          timers.delete(id)
          timer.handler()
          ran = true
        }
      }
    },
  }
}

describe("createHeartbeatMonitor", () => {
  test("fires onTimeout after the configured timeout", () => {
    const fakeTimers = createFakeTimeoutTimers()
    const onTimeout = mock(() => {})

    createHeartbeatMonitor(onTimeout, {
      timeoutMs: 30,
      timers: fakeTimers.timers,
    })

    fakeTimers.advance(29)
    expect(onTimeout).not.toHaveBeenCalled()

    fakeTimers.advance(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  test("markAlive resets the timeout window", () => {
    const fakeTimers = createFakeTimeoutTimers()
    const onTimeout = mock(() => {})

    const monitor = createHeartbeatMonitor(onTimeout, {
      timeoutMs: 30,
      timers: fakeTimers.timers,
    })

    fakeTimers.advance(20)
    monitor.markAlive()
    fakeTimers.advance(20)

    expect(onTimeout).not.toHaveBeenCalled()

    fakeTimers.advance(10)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  test("stop cancels the pending timeout", () => {
    const fakeTimers = createFakeTimeoutTimers()
    const onTimeout = mock(() => {})

    const monitor = createHeartbeatMonitor(onTimeout, {
      timeoutMs: 30,
      timers: fakeTimers.timers,
    })

    monitor.stop()
    fakeTimers.advance(100)

    expect(onTimeout).not.toHaveBeenCalled()
  })
})
