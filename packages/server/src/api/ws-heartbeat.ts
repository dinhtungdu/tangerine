import { WS_HEARTBEAT_INTERVAL_MS, WS_HEARTBEAT_TIMEOUT_MS } from "@tangerine/shared"

interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface TimerApi {
  now(): number
  setInterval(handler: () => void, timeout: number): ReturnType<typeof setInterval>
  clearInterval(timer: ReturnType<typeof setInterval>): void
}

interface CreateWebSocketHeartbeatOptions {
  intervalMs?: number
  timeoutMs?: number
  timers?: Partial<TimerApi>
}

export interface WebSocketHeartbeat {
  start(): void
  markAlive(): void
  stop(): void
}

export function createWebSocketHeartbeat(
  socket: SocketLike,
  options: CreateWebSocketHeartbeatOptions = {},
): WebSocketHeartbeat {
  const intervalMs = options.intervalMs ?? WS_HEARTBEAT_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? WS_HEARTBEAT_TIMEOUT_MS
  const now = options.timers?.now ?? (() => Date.now())
  const startInterval = options.timers?.setInterval ?? ((handler: () => void, timeout: number) => setInterval(handler, timeout))
  const clearTimer = options.timers?.clearInterval ?? ((timer: ReturnType<typeof setInterval>) => clearInterval(timer))

  let lastSeenAt = now()
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  const stop = () => {
    if (timer) {
      clearTimer(timer)
      timer = null
    }
    stopped = true
  }

  const closeStaleSocket = (reason: string) => {
    stop()
    try {
      socket.close(1001, reason)
    } catch {
      // Socket already closed
    }
  }

  const tick = () => {
    if (stopped) return
    if (now() - lastSeenAt >= timeoutMs) {
      closeStaleSocket("Heartbeat timeout")
      return
    }
    try {
      socket.send(JSON.stringify({ type: "ping" }))
    } catch {
      closeStaleSocket("Heartbeat send failed")
    }
  }

  return {
    start() {
      if (stopped || timer) return
      timer = startInterval(tick, intervalMs)
    },
    markAlive() {
      if (stopped) return
      lastSeenAt = now()
    },
    stop,
  }
}
