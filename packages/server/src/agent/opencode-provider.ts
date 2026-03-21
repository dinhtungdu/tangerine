// OpenCode agent provider: spawns OpenCode server inside VM, establishes SSH tunnel,
// creates a session, and bridges SSE events to the normalized AgentEvent stream.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import { VM_USER } from "../config"
import type { AgentFactory, AgentHandle, AgentEvent, AgentStartContext } from "./provider"
import type { SessionTunnel } from "../vm/tunnel"

const log = createLogger("opencode-provider")

export interface OpenCodeProviderDeps {
  sshExec(host: string, port: number, command: string): Effect.Effect<string, import("../errors").SshError>
  createTunnel(opts: {
    vmIp: string
    sshPort: number
    user?: string
    remoteOpencodePort?: number
    remotePreviewPort: number
  }): Effect.Effect<SessionTunnel, import("../errors").TunnelError>
}

/** Maps OpenCode SSE events to normalized AgentEvents */
function mapSseEvent(data: Record<string, unknown>): AgentEvent | null {
  const type = data.type as string | undefined
  if (!type) return null

  switch (type) {
    case "message.part.updated": {
      const part = (data.properties as Record<string, unknown>)?.part as
        | { type: string; text?: string; messageID?: string }
        | undefined
      if (part?.type === "text" && part.text) {
        return { kind: "message.streaming", content: part.text, messageId: part.messageID }
      }
      return null
    }

    case "message.updated": {
      // Handled by the provider's internal accumulator — not mapped here.
      // The provider emits message.complete after assembling text from streaming events.
      return null
    }

    case "session.status": {
      const status = (data.properties as Record<string, unknown>)?.status as
        | { type?: string }
        | undefined
      if (status?.type === "busy") return { kind: "status", status: "working" }
      if (status?.type === "idle") return { kind: "status", status: "idle" }
      return null
    }

    default:
      return null
  }
}

export function createOpenCodeProvider(deps: OpenCodeProviderDeps): AgentFactory {
  return {
    start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
      const taskLog = log.child({ taskId: ctx.taskId })

      return Effect.gen(function* () {
        const opencodeVmPort = 4096

        // Start OpenCode server inside the VM (fire-and-forget)
        yield* Effect.tryPromise({
          try: async () => {
            Bun.spawn(
              [
                "ssh", "-o", "StrictHostKeyChecking=no",
                "-p", String(ctx.sshPort),
                `${VM_USER}@${ctx.vmIp}`,
                `test -f ~/.env && set -a && . ~/.env && set +a; cd ${ctx.workdir} && opencode serve --port ${opencodeVmPort} --hostname 0.0.0.0 > /tmp/opencode.log 2>&1`,
              ],
              { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
            )
            await new Promise((r) => setTimeout(r, 1000))
          },
          catch: (e) =>
            new SessionStartError({
              message: `OpenCode start failed: ${e}`,
              taskId: ctx.taskId,
              phase: "start-opencode",
              cause: e instanceof Error ? e : new Error(String(e)),
            }),
        })
        taskLog.info("OpenCode started")

        // Establish SSH tunnel for OpenCode API and preview
        const tunnel = yield* deps
          .createTunnel({
            vmIp: ctx.vmIp,
            sshPort: ctx.sshPort,
            remoteOpencodePort: opencodeVmPort,
            remotePreviewPort: ctx.previewPort,
          })
          .pipe(
            Effect.mapError(
              (e) =>
                new SessionStartError({
                  message: `Tunnel creation failed: ${e.message}`,
                  taskId: ctx.taskId,
                  phase: "create-tunnel",
                  cause: e,
                }),
            ),
          )
        taskLog.info("Tunnel established", {
          agentPort: tunnel.agentPort,
          previewPort: tunnel.previewPort,
        })

        // Wait for OpenCode health
        yield* Effect.tryPromise({
          try: async () => {
            const maxAttempts = 30
            for (let i = 0; i < maxAttempts; i++) {
              try {
                const res = await fetch(`http://localhost:${tunnel.agentPort}/global/health`)
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

        // Set model via config API if specified (session creation doesn't support model field)
        if (ctx.model) {
          yield* Effect.tryPromise({
            try: async () => {
              const res = await fetch(`http://localhost:${tunnel.agentPort}/config`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: ctx.model }),
              })
              if (!res.ok) taskLog.warn("Config model update failed", { status: res.status })
              else taskLog.info("Model set via config", { model: ctx.model })
            },
            catch: () => new SessionStartError({
              message: `Config update failed`,
              taskId: ctx.taskId,
              phase: "set-model",
              cause: new Error("Config update failed"),
            }),
          }).pipe(Effect.catchAll(() => Effect.void))
        }

        // Create OpenCode session
        const sessionId = yield* Effect.tryPromise({
          try: async () => {
            const r = await fetch(`http://localhost:${tunnel.agentPort}/session`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: ctx.title }),
            })
            if (!r.ok) throw new Error(`Session create failed: ${r.status}`)
            const body = (await r.json()) as { id: string }
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

        const emit = (event: AgentEvent) => {
          for (const cb of subscribers) cb(event)
        }

        /** Process raw OpenCode SSE event — handles message accumulation internally */
        const processRawEvent = (raw: Record<string, unknown>) => {
          const type = raw.type as string | undefined
          if (!type) return

          // Accumulate streaming text
          if (type === "message.part.updated") {
            const part = (raw.properties as Record<string, unknown>)?.part as
              | { type: string; text?: string; messageID?: string }
              | undefined
            if (part?.type === "text" && part.text && part.messageID) {
              textParts.set(part.messageID, part.text)
              emit({ kind: "message.streaming", content: part.text, messageId: part.messageID })
            }
            return
          }

          // Emit complete message when assistant message finishes
          if (type === "message.updated") {
            const info = (raw.properties as Record<string, unknown>)?.info as
              | { id: string; role: string; time?: { completed?: number } }
              | undefined
            if (info?.role === "assistant" && info.time?.completed) {
              const text = textParts.get(info.id)
              if (text) {
                emit({ kind: "message.complete", role: "assistant", content: text, messageId: info.id })
                textParts.delete(info.id)
              }
            }
            return
          }

          // Status events
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
              const response = await fetch(`http://localhost:${tunnel.agentPort}/event`, {
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
                  if (!block.startsWith("data: ")) continue
                  try {
                    const raw = JSON.parse(block.slice(6)) as Record<string, unknown>
                    processRawEvent(raw)
                  } catch {
                    // skip malformed
                  }
                }
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

        const handle: AgentHandle = {
          sendPrompt(text: string) {
            return Effect.tryPromise({
              try: async () => {
                const res = await fetch(
                  `http://localhost:${tunnel.agentPort}/session/${sessionId}/prompt_async`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ parts: [{ type: "text", text }] }),
                  },
                )
                if (!res.ok) {
                  const err = await res.text()
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
                  `http://localhost:${tunnel.agentPort}/session/${sessionId}/abort`,
                  { method: "POST" },
                )
                if (!res.ok) throw new Error(`Abort failed: ${res.status}`)
              },
              catch: (e) =>
                new AgentError({ message: `Abort failed: ${e}`, taskId: ctx.taskId }),
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
                tunnel.process.kill()
              } catch {
                // tunnel may already be dead
              }
              taskLog.info("Agent shutdown")
            })
          },
        }

        // Attach metadata so callers can read session/port info
        ;(handle as AgentHandleWithMeta).__meta = {
          sessionId,
          agentPort: tunnel.agentPort,
          previewPort: tunnel.previewPort,
        }

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
    previewPort: number
  }
}

export function getHandleMeta(handle: AgentHandle): { sessionId: string; agentPort: number; previewPort: number } | null {
  const meta = (handle as AgentHandleWithMeta).__meta
  return meta ?? null
}
