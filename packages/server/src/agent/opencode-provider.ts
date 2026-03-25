// OpenCode agent provider: spawns OpenCode server as a local process,
// creates a session, and bridges SSE events to the normalized AgentEvent stream.

import { Effect } from "effect"
import { createLogger, truncate } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import type { AgentFactory, AgentHandle, AgentEvent, AgentStartContext } from "./provider"

const log = createLogger("opencode-provider")

/** Extract the data payload from an SSE block, handling multi-line formats like "event: foo\ndata: {...}" */
export function extractSseData(block: string): string | null {
  for (const line of block.split("\n")) {
    if (line.startsWith("data: ")) return line.slice(6)
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null
}

function getSessionId(data: Record<string, unknown>): string | null {
  const properties = asRecord(data.properties)
  const part = asRecord(properties?.part)
  const info = asRecord(properties?.info)
  const sessionID = part?.sessionID ?? info?.sessionID ?? properties?.sessionID
  return typeof sessionID === "string" ? sessionID : null
}

function getTextSnapshotEvent(data: Record<string, unknown>, currentText: string): AgentEvent | null {
  const part = asRecord(asRecord(data.properties)?.part)
  if (part?.type !== "text") return null

  const text = typeof part.text === "string" ? part.text : ""
  const messageId = typeof part.messageID === "string" ? part.messageID : undefined
  if (!messageId || !text.startsWith(currentText)) return null

  const delta = text.slice(currentText.length)
  if (!delta) return null
  return { kind: "message.streaming", content: delta, messageId }
}

function getTextDeltaEvent(data: Record<string, unknown>): AgentEvent | null {
  const properties = asRecord(data.properties)
  if (properties?.field !== "text" || typeof properties.delta !== "string") return null
  return {
    kind: "message.streaming",
    content: properties.delta,
    messageId: typeof properties.messageID === "string" ? properties.messageID : undefined,
  }
}

function getToolEvent(data: Record<string, unknown>, previousStatus?: string): AgentEvent | null {
  const part = asRecord(asRecord(data.properties)?.part)
  if (part?.type !== "tool") return null

  const toolName = typeof part.tool === "string" ? part.tool : "unknown"
  const state = asRecord(part.state)
  const status = typeof state?.status === "string" ? state.status : ""

  if ((status === "pending" || status === "running") && previousStatus !== status) {
    const input = state?.input ? truncate(JSON.stringify(state.input), 500) : undefined
    return { kind: "tool.start", toolName, toolInput: input }
  }

  if (status === "completed" && previousStatus !== "completed") {
    const output = typeof state?.output === "string"
      ? state.output
      : typeof state?.metadata === "object" && state.metadata !== null && typeof (state.metadata as Record<string, unknown>).output === "string"
        ? (state.metadata as Record<string, unknown>).output as string
        : undefined
    return { kind: "tool.end", toolName, toolResult: output ? truncate(output, 500) : undefined }
  }

  return null
}

/** Maps OpenCode SSE events to normalized AgentEvents */
export function mapSseEvent(data: Record<string, unknown>, state?: { currentText?: string; previousToolStatus?: string }): AgentEvent | null {
  const type = data.type as string | undefined
  if (!type) return null

  switch (type) {
    case "message.part.delta":
      return getTextDeltaEvent(data)

    case "message.part.updated":
      return getToolEvent(data, state?.previousToolStatus) ?? getTextSnapshotEvent(data, state?.currentText ?? "")

    case "session.status": {
      const status = asRecord(asRecord(data.properties)?.status)
      if (status?.type === "busy") return { kind: "status", status: "working" }
      if (status?.type === "idle") return { kind: "status", status: "idle" }
      return null
    }

    default:
      return null
  }
}

export function createOpenCodeProvider(): AgentFactory {
  return {
    start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
      const taskLog = log.child({ taskId: ctx.taskId })

      return Effect.gen(function* () {
        const opencodePort = 4096

        // Start OpenCode server as a local process
        const proc = Bun.spawn(
          ["opencode", "serve", "--port", String(opencodePort), "--hostname", "127.0.0.1"],
          {
            cwd: ctx.workdir,
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
            env: { ...process.env, ...ctx.env },
          },
        )
        taskLog.info("OpenCode started", { port: opencodePort, pid: proc.pid })

        // Wait for OpenCode health
        yield* Effect.tryPromise({
          try: async () => {
            const maxAttempts = 30
            for (let i = 0; i < maxAttempts; i++) {
              try {
                const res = await fetch(`http://localhost:${opencodePort}/global/health`)
                if (res.ok) return
              } catch {
                // not ready yet
              }
              await new Promise((r) => setTimeout(r, 2000))
            }
            throw new Error(`OpenCode health check failed after ${maxAttempts} attempts`)
          },
          catch: (e) =>
            new SessionStartError({
              message: `Health check failed: ${e}`,
              taskId: ctx.taskId,
              phase: "health-check",
              cause: e instanceof Error ? e : new Error(String(e)),
            }),
        })

        // Create or resume OpenCode session (model is passed per-prompt, not via config)
        const sessionId = yield* Effect.tryPromise({
          try: async () => {
            if (ctx.resumeSessionId) {
              const existing = await fetch(`http://localhost:${opencodePort}/session/${ctx.resumeSessionId}`)
              if (existing.ok) return ctx.resumeSessionId
              taskLog.warn("Resume session not found, creating a new OpenCode session", { resumeSessionId: ctx.resumeSessionId })
            }

            const created = await fetch(`http://localhost:${opencodePort}/session`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: ctx.title }),
            })
            if (!created.ok) throw new Error(`Session create failed: ${created.status}`)
            const body = (await created.json()) as { id: string }
            return body.id
          },
          catch: (e) =>
            new SessionStartError({
              message: `Session creation failed: ${e}`,
              taskId: ctx.taskId,
              phase: "create-session",
              cause: e instanceof Error ? e : new Error(String(e)),
            }),
        })
        taskLog.info("Session created", { sessionId })

        // Build the AgentHandle
        const subscribers = new Set<(e: AgentEvent) => void>()
        let sseAborted = false
        // Accumulate text parts per message ID to assemble complete messages
        const textParts = new Map<string, string>()
        const toolStates = new Map<string, string>()

        const emit = (event: AgentEvent) => {
          for (const cb of subscribers) cb(event)
        }

        /** Process raw OpenCode SSE event — handles message accumulation internally */
        const processRawEvent = (raw: Record<string, unknown>) => {
          if (getSessionId(raw) !== sessionId) return

          const type = raw.type as string | undefined
          if (!type) return

          if (type === "message.part.delta") {
            const properties = asRecord(raw.properties)
            const messageId = typeof properties?.messageID === "string" ? properties.messageID : undefined
            const delta = typeof properties?.delta === "string" ? properties.delta : undefined
            if (messageId && delta && properties?.field === "text") {
              textParts.set(messageId, (textParts.get(messageId) ?? "") + delta)
            }
          }

          if (type === "message.part.updated") {
            const part = asRecord(asRecord(raw.properties)?.part)
            const messageId = typeof part?.messageID === "string" ? part.messageID : undefined

            if (part?.type === "text" && messageId && typeof part.text === "string") {
              const currentText = textParts.get(messageId) ?? ""
              if (part.text.startsWith(currentText)) {
                textParts.set(messageId, part.text)
              }
            }

            if (part?.type === "tool") {
              const callId = typeof part.callID === "string" ? part.callID : undefined
              const status = typeof asRecord(part.state)?.status === "string" ? asRecord(part.state)?.status as string : undefined
              const mapped = mapSseEvent(raw, {
                currentText: messageId ? (textParts.get(messageId) ?? "") : "",
                previousToolStatus: callId ? toolStates.get(callId) : undefined,
              })
              if (callId && status) toolStates.set(callId, status)
              if (mapped) emit(mapped)
              return
            }
          }

          // Emit complete message when assistant message finishes
          if (type === "message.updated") {
            const info = asRecord(asRecord(raw.properties)?.info) as
              | { id?: string; role?: string; time?: { completed?: number } }
              | null
            if (info?.role === "assistant" && info.time?.completed) {
              const messageId = typeof info.id === "string" ? info.id : undefined
              const text = messageId ? textParts.get(messageId) : undefined
              // Emit message.complete even for empty text (tool-only messages)
              if (messageId) {
                emit({ kind: "message.complete", role: "assistant", content: text ?? "", messageId })
                textParts.delete(messageId)
              }
            }
            return
          }

          const mapped = mapSseEvent(raw)
          if (mapped) emit(mapped)
        }

        // Start SSE subscription in background
        const connectSse = async () => {
          if (sseAborted) return
          let attempt = 0
          const maxAttempts = 10

          const doConnect = async (): Promise<void> => {
            if (sseAborted) return
            try {
              const response = await fetch(`http://localhost:${opencodePort}/event`, {
                headers: { Accept: "text/event-stream" },
              })
              if (!response.ok || !response.body) {
                throw new Error(`SSE connect failed: ${response.status}`)
              }
              if (attempt > 0) taskLog.info("SSE reconnected", { previousAttempts: attempt })
              attempt = 0

              const reader = response.body.getReader()
              const decoder = new TextDecoder()
              let buffer = ""

              while (!sseAborted) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split("\n\n")
                buffer = lines.pop() ?? ""

                for (const block of lines) {
                  // Extract data line from SSE block — handles both
                  // "data: {...}" and "event: foo\ndata: {...}" formats
                  const dataLine = extractSseData(block)
                  if (!dataLine) continue
                  try {
                    const raw = JSON.parse(dataLine) as Record<string, unknown>
                    processRawEvent(raw)
                  } catch {
                    // skip malformed
                  }
                }
              }

              // Stream ended gracefully (server closed connection) — reconnect
              if (!sseAborted) {
                taskLog.debug("SSE stream ended, reconnecting")
                await new Promise((r) => setTimeout(r, 500))
                return doConnect()
              }
            } catch {
              if (sseAborted) return
              attempt++
              if (attempt <= maxAttempts) {
                taskLog.warn("SSE disconnected, reconnecting", { attempt })
                const delay = Math.min(1000 * 2 ** (attempt - 1), 30000)
                await new Promise((r) => setTimeout(r, delay))
                return doConnect()
              }
              taskLog.error("SSE failed permanently", { attempts: attempt })
            }
          }

          await doConnect()
        }
        connectSse()

        // Track active model — split "provider/model" into providerID + modelID for prompt_async
        let activeModel = ctx.model ?? ""

        function buildModelPayload(): Record<string, unknown> | undefined {
          if (!activeModel || !activeModel.includes("/")) return undefined
          const [providerID, ...rest] = activeModel.split("/")
          return { providerID, modelID: rest.join("/") }
        }

        const handle: AgentHandle = {
          sendPrompt(text: string, images?: import("./provider").PromptImage[]) {
            return Effect.tryPromise({
              try: async () => {
                const fileParts = images
                  ? images.map((img, i) => ({
                      type: "file" as const,
                      mime: img.mediaType,
                      filename: `image-${i}.${img.mediaType.split("/")[1] ?? "png"}`,
                      url: `data:${img.mediaType};base64,${img.data}`,
                    }))
                  : []
                const body: Record<string, unknown> = { parts: [...fileParts, { type: "text", text }] }
                const modelPayload = buildModelPayload()
                if (modelPayload) body.model = modelPayload

                taskLog.debug("Sending prompt", {
                  hasImages: fileParts.length > 0,
                  imageCount: fileParts.length,
                  textLength: text.length,
                })

                const res = await fetch(
                  `http://localhost:${opencodePort}/session/${sessionId}/prompt_async`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                  },
                )
                if (!res.ok) {
                  const err = await res.text()
                  taskLog.error("OpenCode prompt failed", { status: res.status, error: err, hasImages: fileParts.length > 0 })
                  throw new Error(`OpenCode prompt failed (${res.status}): ${err}`)
                }
              },
              catch: (e) =>
                new PromptError({ message: `Failed to send prompt: ${e}`, taskId: ctx.taskId }),
            })
          },

          abort() {
            return Effect.tryPromise({
              try: async () => {
                const res = await fetch(
                  `http://localhost:${opencodePort}/session/${sessionId}/abort`,
                  { method: "POST" },
                )
                if (!res.ok) throw new Error(`Abort failed: ${res.status}`)
              },
              catch: (e) =>
                new AgentError({ message: `Abort failed: ${e}`, taskId: ctx.taskId }),
            })
          },

          updateConfig(config: import("./provider").AgentConfig) {
            // Model is passed per-prompt via prompt_async — just update the tracked value
            return Effect.sync(() => {
              if (config.model) {
                activeModel = config.model
                taskLog.info("Model updated", { model: activeModel })
              }
              // Reasoning effort for OpenCode would need provider-specific config,
              // but prompt_async doesn't support it directly — silently accepted
              return true
            })
          },

          subscribe(onEvent: (e: AgentEvent) => void) {
            subscribers.add(onEvent)
            return {
              unsubscribe() {
                subscribers.delete(onEvent)
              },
            }
          },

          shutdown() {
            return Effect.sync(() => {
              sseAborted = true
              subscribers.clear()
              try {
                proc.kill()
              } catch {
                // process may already be dead
              }
              taskLog.info("Agent shutdown")
            })
          },
        }

        // Attach metadata so callers can read session/port info
        ;(handle as AgentHandleWithMeta).__meta = {
          sessionId,
          agentPort: opencodePort,
        }
        ;(handle as { __pid?: number }).__pid = proc.pid

        return handle
      })
    },
  }
}

/** Extended handle with OpenCode-specific metadata (sessionId, ports) */
export interface AgentHandleWithMeta extends AgentHandle {
  __meta: {
    sessionId: string
    agentPort: number
  }
}

export function getHandleMeta(handle: AgentHandle): { sessionId: string; agentPort: number } | null {
  const meta = (handle as AgentHandleWithMeta).__meta
  return meta ?? null
}
