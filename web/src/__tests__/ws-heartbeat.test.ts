import { describe, expect, test, mock } from "bun:test"
import { createHeartbeatMonitor } from "../lib/ws-heartbeat"
import { createFakeTimeoutTimers } from "./fake-timeout-timers"

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
