// SSE event bridge: subscribes to OpenCode's event stream and relays to consumers.
// Wraps the SSE lifecycle in Effect so callers get typed connection errors
// and the subscription can be cleanly interrupted.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { AgentConnectionError } from "../errors"

const log = createLogger("events")

export type EventHandler = (event: unknown) => void

export interface SseSubscription {
  unsubscribe(): void
}

/**
 * Subscribes to an OpenCode SSE event stream. Returns an unsubscribe
 * handle wrapped in Effect. The connection loop runs in the background
 * with exponential-backoff reconnection so callers only need to hold
 * the unsubscribe handle.
 */
export function subscribeToEvents(
  agentPort: number,
  taskId: string,
  onEvent: EventHandler,
  options?: { maxReconnectAttempts?: number },
): Effect.Effect<SseSubscription, AgentConnectionError> {
  return Effect.try({
    try: () => {
      const taskLog = log.child({ taskId })
      const maxAttempts = options?.maxReconnectAttempts ?? 10
      let cancelled = false
      let attempt = 0

      taskLog.info("SSE subscribed", { agentPort })

      async function connect(): Promise<void> {
        if (cancelled) return

        try {
          const response = await fetch(`http://localhost:${agentPort}/event`, {
            headers: { Accept: "text/event-stream" },
          })

          if (!response.ok || !response.body) {
            throw new Error(`SSE connect failed: ${response.status}`)
          }

          // Reset attempt counter on successful connection
          if (attempt > 0) {
            taskLog.info("SSE reconnected", { previousAttempts: attempt })
          }
          attempt = 0

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""

          while (!cancelled) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n\n")
            // Keep incomplete last chunk in buffer
            buffer = lines.pop() ?? ""

            for (const block of lines) {
              if (!block.startsWith("data: ")) continue
              try {
                const data = JSON.parse(block.slice(6))
                taskLog.debug("SSE event received", { eventType: data.type ?? "unknown" })
                onEvent(data)
              } catch {
                // Skip malformed SSE frames
              }
            }
          }
        } catch (err) {
          if (cancelled) return

          attempt++
          if (attempt <= maxAttempts) {
            taskLog.warn("SSE disconnected, reconnecting", {
              attempt,
              error: err instanceof Error ? err.message : String(err),
            })
            // Exponential backoff capped at 30s
            const delay = Math.min(1000 * 2 ** (attempt - 1), 30000)
            await new Promise((resolve) => setTimeout(resolve, delay))
            return connect()
          }

          taskLog.error("SSE failed permanently", {
            attempts: attempt,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Start connection in background
      connect()

      return {
        unsubscribe() {
          cancelled = true
          taskLog.debug("SSE unsubscribed")
        },
      }
    },
    catch: (e) =>
      new AgentConnectionError({
        message: "Failed to start SSE subscription",
        taskId,
        url: `http://localhost:${agentPort}/event`,
        cause: e,
      }),
  })
}
