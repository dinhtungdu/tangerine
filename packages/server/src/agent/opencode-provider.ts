// OpenCode agent provider: spawns a per-task OpenCode server process,
// creates a session, and bridges SSE events to the normalized AgentEvent stream.
//
// Each task gets its own OpenCode server on a unique port. The task owns
// the process and kills it on shutdown — no shared state between tasks.

import { Effect } from "effect"
import { createLogger, truncate } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import type { AgentFactory, AgentHandle, AgentEvent, AgentStartContext, PromptImage } from "./provider"
import { homedir } from "node:os"
import { join } from "node:path"

const log = createLogger("opencode-provider")

// -- Per-task server spawning -------------------------------------------------
// Each task gets its own OpenCode server on a unique port. Port range starts
// at BASE_PORT and increments; wraps around after 1000 ports.

const BASE_PORT = 14096
let nextPort = BASE_PORT

function allocatePort(): number {
  const port = nextPort
  nextPort = nextPort >= BASE_PORT + 999 ? BASE_PORT : nextPort + 1
  return port
}

/**
 * Spawn a new OpenCode server for a single task. Returns the process and port.
 */
async function spawnServer(
  workdir: string,
  env: Record<string, string | undefined>,
  taskLog: ReturnType<typeof log.child>,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; port: number }> {
  await ensureOpenCodeConfig()

  const port = allocatePort()
  const proc = Bun.spawn(
    ["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: workdir,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...process.env, ...env },
    },
  )
  taskLog.info("OpenCode server spawned", { pid: proc.pid, port })

  // Wait for health
  const maxAttempts = 30
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/global/health`)
      if (res.ok) return { proc, port }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000))
  }

  try { proc.kill() } catch { /* may already be dead */ }
  throw new Error(`OpenCode health check failed after ${maxAttempts} attempts on port ${port}`)
}

// -- OpenCode permission config ------------------------------------------------
// OpenCode's permission system blocks tools accessing paths outside the project dir
// (e.g. /tmp/*). Since Tangerine runs in a sandbox VM, we auto-allow everything
// by writing the config before starting the server.

const OPENCODE_CONFIG: Record<string, unknown> = {
  agent: {
    build: {
      permission: {
        external_directory: "allow",
        doom_loop: "allow",
      },
    },
  },
}

let configEnsured = false

async function ensureOpenCodeConfig(): Promise<void> {
  if (configEnsured) return
  const configDir = join(homedir(), ".config", "opencode")
  const configPath = join(configDir, "opencode.json")

  try {
    const file = Bun.file(configPath)
    if (await file.exists()) {
      // Merge our permission config with existing config
      const existing = JSON.parse(await file.text()) as Record<string, unknown>
      const existingAgent = (existing.agent ?? {}) as Record<string, unknown>
      const existingBuild = (existingAgent.build ?? {}) as Record<string, unknown>
      const existingPerm = (existingBuild.permission ?? {}) as Record<string, unknown>
      const ourPerm = (OPENCODE_CONFIG.agent as Record<string, unknown>).build as Record<string, unknown>
      const merged = {
        ...existing,
        agent: {
          ...existingAgent,
          build: {
            ...existingBuild,
            permission: {
              ...existingPerm,
              ...(ourPerm.permission as Record<string, unknown>),
            },
          },
        },
      }
      await Bun.write(configPath, JSON.stringify(merged, null, 2) + "\n")
    } else {
      await Bun.write(configPath, JSON.stringify(OPENCODE_CONFIG, null, 2) + "\n")
    }
    configEnsured = true
    log.info("OpenCode config ensured", { path: configPath })
  } catch (err) {
    log.warn("Failed to write OpenCode config, permissions may prompt", { error: String(err) })
  }
}

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
  const status = asRecord(properties?.status)
  const sessionID = part?.sessionID ?? info?.sessionID ?? status?.sessionID ?? properties?.sessionID
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

// ---------------------------------------------------------------------------
// Extracted event processor — testable independently of the provider
// ---------------------------------------------------------------------------

export interface OpenCodeProcessorCallbacks {
  emit: (event: AgentEvent) => void
  onPermissionRequest?: (permissionId: string) => void
}

/**
 * Creates a stateful SSE event processor for OpenCode. Manages text/image
 * accumulation, message completion, and idle-promotion — everything that
 * processRawEvent used to do inline inside start().
 */
export function createOpenCodeEventProcessor(sessionId: string, callbacks: OpenCodeProcessorCallbacks) {
  const textParts = new Map<string, string>()
  const toolStates = new Map<string, string>()
  const imageParts = new Map<string, PromptImage[]>()
  let lastNarration: { content: string; messageId?: string; images?: PromptImage[] } | null = null

  function extractImageFromDataUrl(messageId: string, url: string) {
    const dataUrlMatch = url.match(/^data:(image\/[\w+]+);base64,(.+)$/)
    if (dataUrlMatch?.[1] && dataUrlMatch[2]) {
      const mediaType = dataUrlMatch[1] as PromptImage["mediaType"]
      const data = dataUrlMatch[2]
      const existing = imageParts.get(messageId) ?? []
      existing.push({ mediaType, data })
      imageParts.set(messageId, existing)
    }
  }

  const process = (raw: Record<string, unknown>) => {
    const eventSessionId = getSessionId(raw)
    if (eventSessionId !== null && eventSessionId !== sessionId) return

    const type = raw.type as string | undefined
    if (!type) return

    if (type === "session.error") {
      const properties = asRecord(raw.properties)
      const error = asRecord(properties?.error)
      const message = typeof error?.data === "object" && error.data !== null
        ? (error.data as Record<string, unknown>).message
        : error?.message
      if (typeof message === "string") {
        callbacks.emit({ kind: "error", message })
      }
      return
    }

    if (type === "permission.asked") {
      const properties = asRecord(raw.properties)
      const permissionId = typeof properties?.id === "string" ? properties.id : null
      if (permissionId) callbacks.onPermissionRequest?.(permissionId)
      return
    }

    if (type === "message.part.delta") {
      const properties = asRecord(raw.properties)
      const messageId = typeof properties?.messageID === "string" ? properties.messageID : undefined
      const delta = typeof properties?.delta === "string" ? properties.delta : undefined
      if (messageId && delta && properties?.field === "text") {
        textParts.set(messageId, (textParts.get(messageId) ?? "") + delta)
      }
      if (messageId && delta && properties?.field === "thinking") {
        callbacks.emit({ kind: "thinking", content: delta })
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

      if (part?.type === "thinking" && typeof part.text === "string") {
        callbacks.emit({ kind: "thinking", content: truncate(part.text, 300) })
        return
      }

      if (part?.type === "file" && messageId && typeof part.mime === "string" && part.mime.startsWith("image/") && typeof part.url === "string") {
        extractImageFromDataUrl(messageId, part.url as string)
        return
      }

      if (part?.type === "tool") {
        const callId = typeof part.callID === "string" ? part.callID : undefined
        const state = asRecord(part.state)
        const status = typeof state?.status === "string" ? state.status as string : undefined
        const mapped = mapSseEvent(raw, {
          currentText: messageId ? (textParts.get(messageId) ?? "") : "",
          previousToolStatus: callId ? toolStates.get(callId) : undefined,
        })
        if (callId && status) toolStates.set(callId, status)
        if (mapped) callbacks.emit(mapped)

        // Extract images from tool result attachments (e.g. Read tool on image files)
        if (messageId && status === "completed" && Array.isArray(state?.attachments)) {
          for (const att of state.attachments as Array<Record<string, unknown>>) {
            if (att.type === "file" && typeof att.mime === "string" && att.mime.startsWith("image/") && typeof att.url === "string") {
              extractImageFromDataUrl(messageId, att.url as string)
            }
          }
        }
        return
      }
    }

    if (type === "message.updated") {
      const info = asRecord(asRecord(raw.properties)?.info) as
        | { id?: string; role?: string; time?: { completed?: number } }
        | null
      if (info?.role === "assistant" && info.time?.completed) {
        const messageId = typeof info.id === "string" ? info.id : undefined
        const text = messageId ? textParts.get(messageId) : undefined
        const images = messageId ? imageParts.get(messageId) : undefined
        if (messageId && (text || images?.length)) {
          lastNarration = { content: text ?? "", messageId, images }
          callbacks.emit({ kind: "message.complete", role: "narration", content: text ?? "", messageId, images })
        }
        if (messageId) {
          textParts.delete(messageId)
          imageParts.delete(messageId)
        }
      }
      return
    }

    const mapped = mapSseEvent(raw)
    if (mapped) {
      if (mapped.kind === "status" && mapped.status === "idle" && lastNarration) {
        callbacks.emit({ kind: "message.complete", role: "assistant", content: lastNarration.content, messageId: lastNarration.messageId, images: lastNarration.images })
        lastNarration = null
      }
      callbacks.emit(mapped)
    }
  }

  return { process }
}

export function createOpenCodeProvider(): AgentFactory {
  return {
    start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
      const taskLog = log.child({ taskId: ctx.taskId })

      return Effect.gen(function* () {
        // Spawn a dedicated OpenCode server for this task
        const { proc: serverProc, port: opencodePort } = yield* Effect.tryPromise({
          try: () => spawnServer(ctx.workdir, ctx.env ?? {}, taskLog),
          catch: (e) =>
            new SessionStartError({
              message: `Failed to spawn OpenCode server: ${e}`,
              taskId: ctx.taskId,
              phase: "health-check",
              cause: e instanceof Error ? e : new Error(String(e)),
            }),
        })
        const serverPid = serverProc.pid
        taskLog.info("OpenCode server ready", { port: opencodePort, pid: serverPid })

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
              body: JSON.stringify({ title: ctx.title, directory: ctx.workdir }),
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
        let sseConnected = false

        const emit = (event: AgentEvent) => {
          for (const cb of subscribers) cb(event)
        }

        /** Auto-approve permission requests — Tangerine runs in a sandbox VM */
        const autoApprovePermission = async (permissionId: string) => {
          try {
            const res = await fetch(
              `http://localhost:${opencodePort}/session/${sessionId}/permissions/${permissionId}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ response: "always" }),
              },
            )
            if (res.ok) {
              taskLog.info("Auto-approved permission", { permissionId })
            } else {
              taskLog.warn("Failed to auto-approve permission", { permissionId, status: res.status })
            }
          } catch (err) {
            taskLog.warn("Error auto-approving permission", { permissionId, error: String(err) })
          }
        }

        const eventProcessor = createOpenCodeEventProcessor(sessionId, {
          emit,
          onPermissionRequest: autoApprovePermission,
        })
        const processRawEvent = eventProcessor.process

        // Start SSE subscription in background
        const connectSse = async () => {
          if (sseAborted) return
          let attempt = 0
          const maxAttempts = 10

          const doConnect = async (): Promise<void> => {
            if (sseAborted) return
            try {
              const response = await fetch(`http://localhost:${opencodePort}/event?directory=${encodeURIComponent(ctx.workdir)}`, {
                headers: { Accept: "text/event-stream" },
              })
              if (!response.ok || !response.body) {
                throw new Error(`SSE connect failed: ${response.status}`)
              }
              sseConnected = true
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
              sseConnected = false
              if (!sseAborted) {
                taskLog.debug("SSE stream ended, reconnecting")
                await new Promise((r) => setTimeout(r, 500))
                return doConnect()
              }
            } catch {
              sseConnected = false
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
                  `http://localhost:${opencodePort}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(ctx.workdir)}`,
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
                  `http://localhost:${opencodePort}/session/${sessionId}/abort?directory=${encodeURIComponent(ctx.workdir)}`,
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
              sseConnected = false
              subscribers.clear()
              try { serverProc.kill() } catch { /* already dead */ }
              taskLog.info("Agent shutdown")
            })
          },

          isAlive() {
            if (!sseConnected) return false
            try {
              process.kill(serverPid, 0)
              return true
            } catch {
              return false
            }
          },
        }

        // Attach metadata so callers can read session/port info
        ;(handle as AgentHandleWithMeta).__meta = {
          sessionId,
          agentPort: opencodePort,
        }
        ;(handle as { __pid?: number }).__pid = serverPid

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
