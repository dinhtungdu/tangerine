export function createFakeTimeoutTimers() {
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
