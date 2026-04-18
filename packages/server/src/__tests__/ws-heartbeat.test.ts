import { describe, expect, test, mock } from "bun:test"
import { createWebSocketHeartbeat } from "../api/ws-heartbeat"

function createFakeIntervalTimers() {
  let now = 0
  let nextId = 1
  const intervals = new Map<number, { handler: () => void; timeout: number; nextAt: number }>()

  return {
    timers: {
      now: () => now,
      setInterval(handler: () => void, timeout: number) {
        const id = nextId++
        intervals.set(id, { handler, timeout, nextAt: now + timeout })
        return id as unknown as ReturnType<typeof setInterval>
      },
      clearInterval(timer: ReturnType<typeof setInterval>) {
        intervals.delete(timer as unknown as number)
      },
    },
    advance(ms: number) {
      now += ms
      let ran = true
      while (ran) {
        ran = false
        for (const [id, interval] of [...intervals.entries()]) {
          if (interval.nextAt > now) continue
          interval.nextAt += interval.timeout
          intervals.set(id, interval)
          interval.handler()
          ran = true
        }
      }
    },
  }
}

describe("createWebSocketHeartbeat", () => {
  test("sends ping frames before the connection goes stale", () => {
    const fakeTimers = createFakeIntervalTimers()
    const socket = {
      send: mock(() => {}),
      close: mock(() => {}),
    }

    const heartbeat = createWebSocketHeartbeat(socket, {
      intervalMs: 10,
      timeoutMs: 30,
      timers: fakeTimers.timers,
    })

    heartbeat.start()
    fakeTimers.advance(20)

    expect(socket.send).toHaveBeenCalledTimes(2)
    expect(socket.close).not.toHaveBeenCalled()
    expect((socket.send as ReturnType<typeof mock>).mock.calls.map(([payload]) => payload)).toEqual([
      JSON.stringify({ type: "ping" }),
      JSON.stringify({ type: "ping" }),
    ])
  })

  test("closes stale sockets after the timeout", () => {
    const fakeTimers = createFakeIntervalTimers()
    const socket = {
      send: mock(() => {}),
      close: mock(() => {}),
    }

    const heartbeat = createWebSocketHeartbeat(socket, {
      intervalMs: 10,
      timeoutMs: 30,
      timers: fakeTimers.timers,
    })

    heartbeat.start()
    fakeTimers.advance(30)

    expect(socket.close).toHaveBeenCalledWith(1001, "Heartbeat timeout")
  })

  test("markAlive extends the deadline", () => {
    const fakeTimers = createFakeIntervalTimers()
    const socket = {
      send: mock(() => {}),
      close: mock(() => {}),
    }

    const heartbeat = createWebSocketHeartbeat(socket, {
      intervalMs: 10,
      timeoutMs: 30,
      timers: fakeTimers.timers,
    })

    heartbeat.start()
    fakeTimers.advance(20)
    heartbeat.markAlive()
    fakeTimers.advance(20)

    expect(socket.close).not.toHaveBeenCalled()

    fakeTimers.advance(10)
    expect(socket.close).toHaveBeenCalledWith(1001, "Heartbeat timeout")
  })

  test("stop cancels future pings and timeout checks", () => {
    const fakeTimers = createFakeIntervalTimers()
    const socket = {
      send: mock(() => {}),
      close: mock(() => {}),
    }

    const heartbeat = createWebSocketHeartbeat(socket, {
      intervalMs: 10,
      timeoutMs: 30,
      timers: fakeTimers.timers,
    })

    heartbeat.start()
    heartbeat.stop()
    fakeTimers.advance(100)

    expect(socket.send).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()
  })
})
