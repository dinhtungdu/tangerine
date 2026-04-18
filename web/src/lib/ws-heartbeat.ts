import { WS_HEARTBEAT_TIMEOUT_MS } from "@tangerine/shared"

interface TimerApi {
  setTimeout(handler: () => void, timeout: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

interface CreateHeartbeatMonitorOptions {
  timeoutMs?: number
  timers?: Partial<TimerApi>
}

export interface HeartbeatMonitor {
  markAlive(): void
  stop(): void
}

export function createHeartbeatMonitor(
  onTimeout: () => void,
  options: CreateHeartbeatMonitorOptions = {},
): HeartbeatMonitor {
  const timeoutMs = options.timeoutMs ?? WS_HEARTBEAT_TIMEOUT_MS
  const setTimer = options.timers?.setTimeout ?? ((handler: () => void, timeout: number) => setTimeout(handler, timeout))
  const clearTimer = options.timers?.clearTimeout ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer))

  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const schedule = () => {
    if (stopped) return
    if (timer) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      if (stopped) return
      onTimeout()
    }, timeoutMs)
  }

  schedule()

  return {
    markAlive() {
      schedule()
    },
    stop() {
      stopped = true
      if (timer) {
        clearTimer(timer)
        timer = null
      }
    },
  }
}
