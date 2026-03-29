// OpenCode agent provider: spawns `opencode run` per prompt with stdin/stdout NDJSON.
// Sessions persist to disk via `-s <session>`, enabling idle suspension and resume.
//
// Each prompt spawns a fresh `opencode run` process. The process exits after
// completing the turn; the next prompt re-invokes with the same session ID.

import { Effect } from "effect"
import { createLogger, truncate } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import type { AgentFactory, AgentHandle, AgentEvent, AgentStartContext, PromptImage, ModelInfo } from "./provider"
import { parseNdjsonStream } from "./ndjson"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const log = createLogger("opencode-provider")

// -- OpenCode permission config ------------------------------------------------
// OpenCode's permission system blocks tools accessing paths outside the project dir
// (e.g. /tmp/*). Since Tangerine runs in a sandbox VM, we auto-allow everything
// by writing the config before starting the process.

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

// -- Event mapping helpers (shared between SSE and NDJSON) --------------------

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

/** Maps OpenCode NDJSON events to normalized AgentEvents */
export function mapOpenCodeEvent(data: Record<string, unknown>, state?: { currentText?: string; previousToolStatus?: string }): AgentEvent | null {
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
 * Creates a stateful event processor for OpenCode NDJSON output. Manages
 * text/image accumulation, message completion, and idle-promotion.
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
        const mapped = mapOpenCodeEvent(raw, {
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
          // Images only go on the assistant message (idle promotion), not narration —
          // matches Claude Code's behavior where images attach to the result, not narration.
          if (text) {
            callbacks.emit({ kind: "message.complete", role: "narration", content: text, messageId })
          }
        }
        if (messageId) {
          textParts.delete(messageId)
          imageParts.delete(messageId)
        }
      }
      return
    }

    const mapped = mapOpenCodeEvent(raw)
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

// ---------------------------------------------------------------------------
// Provider implementation — subprocess per prompt
// ---------------------------------------------------------------------------

export function createOpenCodeProvider(): AgentFactory {
  return {
    start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
      const taskLog = log.child({ taskId: ctx.taskId })

      return Effect.tryPromise({
        try: async () => {
          await ensureOpenCodeConfig()

          const sessionId = ctx.resumeSessionId ?? crypto.randomUUID()
          taskLog.info("OpenCode session initialized", { sessionId, isResume: !!ctx.resumeSessionId })

          const subscribers = new Set<(e: AgentEvent) => void>()
          let shutdownCalled = false
          let currentProc: ReturnType<typeof Bun.spawn> | null = null
          let currentParser: { stop(): void } | null = null

          // Track active model — split "provider/model" for CLI flags
          let activeModel = ctx.model ?? ""

          const emit = (event: AgentEvent) => {
            for (const cb of subscribers) cb(event)
          }

          const eventProcessor = createOpenCodeEventProcessor(sessionId, {
            emit,
            // Permissions are handled by ensureOpenCodeConfig — no runtime approval needed
          })

          // Emit initial idle so the task system knows we're ready
          queueMicrotask(() => emit({ kind: "status", status: "idle" }))

          /** Build CLI args for `opencode run` */
          function buildArgs(): string[] {
            const args = ["opencode", "run", "--format", "json", "-s", sessionId]
            if (activeModel) {
              args.push("-m", activeModel)
            }
            if (ctx.reasoningEffort) {
              args.push("--reasoning-effort", ctx.reasoningEffort)
            }
            return args
          }

          const handle: AgentHandle = {
            sendPrompt(text: string, _images?: PromptImage[]) {
              return Effect.tryPromise({
                try: async () => {
                  if (shutdownCalled) throw new Error("Agent shut down")

                  // Kill any previous process that hasn't exited yet
                  if (currentProc) {
                    try { currentProc.kill() } catch { /* already dead */ }
                    currentParser?.stop()
                    currentProc = null
                    currentParser = null
                  }

                  const args = buildArgs()
                  taskLog.debug("Spawning opencode run", { args: args.join(" "), textLength: text.length })

                  const proc = Bun.spawn(args, {
                    cwd: ctx.workdir,
                    stdin: "pipe",
                    stdout: "pipe",
                    stderr: "pipe",
                    env: { ...process.env, ...ctx.env },
                  })
                  currentProc = proc

                  emit({ kind: "status", status: "working" })

                  // Parse NDJSON from stdout
                  const parser = parseNdjsonStream(
                    proc.stdout as ReadableStream<Uint8Array>,
                    {
                      onLine: (data) => {
                        eventProcessor.process(data as Record<string, unknown>)
                      },
                      onError: (err) => {
                        if (!shutdownCalled) {
                          taskLog.error("stdout parse error", { error: err.message })
                          emit({ kind: "error", message: err.message })
                        }
                      },
                      onEnd: () => {
                        if (!shutdownCalled) {
                          taskLog.debug("opencode run stdout ended")
                          // Process completed its turn — emit idle
                          emit({ kind: "status", status: "idle" })
                        }
                      },
                    },
                  )
                  currentParser = parser

                  // Log stderr in background
                  ;(async () => {
                    try {
                      const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
                      const decoder = new TextDecoder()
                      while (true) {
                        const { done, value } = await stderrReader.read()
                        if (done) break
                        const line = decoder.decode(value, { stream: true }).trim()
                        if (line) taskLog.debug("opencode stderr", { text: line })
                      }
                    } catch {
                      // stderr may close abruptly
                    }
                  })()

                  // Write prompt to stdin and close to signal input complete
                  proc.stdin.write(text)
                  proc.stdin.end()
                },
                catch: (e) =>
                  new PromptError({ message: `Failed to send prompt: ${e}`, taskId: ctx.taskId }),
              })
            },

            abort() {
              return Effect.try({
                try: () => {
                  if (currentProc) {
                    currentProc.kill("SIGINT")
                  }
                },
                catch: (e) =>
                  new AgentError({ message: `Abort failed: ${e}`, taskId: ctx.taskId }),
              })
            },

            updateConfig(config: import("./provider").AgentConfig) {
              return Effect.sync(() => {
                if (config.model) {
                  activeModel = config.model
                  taskLog.info("Model updated", { model: activeModel })
                }
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
                shutdownCalled = true
                currentParser?.stop()
                subscribers.clear()
                if (currentProc) {
                  try { currentProc.kill() } catch { /* already dead */ }
                  currentProc = null
                }
                currentParser = null
                taskLog.info("Agent shutdown")
              })
            },

            isAlive() {
              // Between prompts there's no process — that's normal for this provider.
              // Return true unless shutdown was called.
              if (shutdownCalled) return false
              // If a process is running, check it's still alive
              if (currentProc) {
                try {
                  process.kill(currentProc.pid, 0)
                  return true
                } catch {
                  return false
                }
              }
              return true
            },
          }

          // Attach metadata so callers can read session info
          Object.defineProperty(handle, "__meta", {
            get: () => ({
              sessionId,
              agentPort: null as number | null,
            }),
          })
          // Attach PID getter — currentProc changes per prompt
          Object.defineProperty(handle, "__pid", {
            get: () => currentProc?.pid ?? null,
          })

          return handle
        },
        catch: (e) =>
          new SessionStartError({
            message: `OpenCode start failed: ${e}`,
            taskId: ctx.taskId,
            phase: "start-opencode",
            cause: e instanceof Error ? e : new Error(String(e)),
          }),
      })
    },
  }
}

/** Extended handle with OpenCode-specific metadata */
export interface AgentHandleWithMeta extends AgentHandle {
  __meta: {
    sessionId: string
    agentPort: number | null
  }
}

export function getHandleMeta(handle: AgentHandle): { sessionId: string; agentPort: number | null } | null {
  const meta = (handle as AgentHandleWithMeta).__meta
  return meta ?? null
}

// ---------------------------------------------------------------------------
// Model discovery — reads OpenCode's local cache and config to find available
// models without starting a server process.
// ---------------------------------------------------------------------------

const OPENCODE_MODELS_CACHE = join(homedir(), ".cache", "opencode", "models.json")
const OPENCODE_AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json")
const OPENCODE_CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json")

interface ProviderEntry {
  id: string
  name: string
  env?: string[]
  models: Record<string, { id: string; name?: string }>
}

interface ConfigProviderEntry {
  name?: string
  npm?: string
  options?: Record<string, unknown>
  models?: Record<string, { name?: string; [key: string]: unknown }>
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {
    return null
  }
}

function buildModelInfos(
  providerId: string,
  providerName: string,
  models: Record<string, { name?: string; [key: string]: unknown }>,
): ModelInfo[] {
  return Object.entries(models).map(([modelId, model]) => ({
    id: `${providerId}/${modelId}`,
    name: model.name ?? modelId,
    provider: providerId,
    providerName,
  }))
}

function readAuthedProviders(): Set<string> {
  const auth = readJsonFile<Record<string, unknown>>(OPENCODE_AUTH_PATH)
  return new Set(auth ? Object.keys(auth) : [])
}

function discoverCacheModels(): { models: ModelInfo[]; availableProviders: Set<string> } {
  const catalog = readJsonFile<Record<string, ProviderEntry>>(OPENCODE_MODELS_CACHE)
  if (!catalog) return { models: [], availableProviders: new Set() }

  const authedProviders = readAuthedProviders()
  const availableProviders = new Set<string>()
  const models: ModelInfo[] = []

  for (const [providerId, provider] of Object.entries(catalog)) {
    const hasOAuth = authedProviders.has(providerId)
    const hasEnvVar = provider.env?.some((e) => !!process.env[e]) ?? false
    if (!hasOAuth && !hasEnvVar) continue

    availableProviders.add(providerId)
    models.push(...buildModelInfos(providerId, provider.name ?? providerId, provider.models ?? {}))
  }

  return { models, availableProviders }
}

function discoverConfigModels(availableCacheProviders: Set<string>): ModelInfo[] {
  const config = readJsonFile<{ provider?: Record<string, ConfigProviderEntry> }>(OPENCODE_CONFIG_PATH)
  if (!config?.provider) return []

  const models: ModelInfo[] = []
  for (const [providerId, provider] of Object.entries(config.provider)) {
    if (!provider.models) continue
    const isCustomProvider = !!(provider.npm || provider.options)
    if (!isCustomProvider && !availableCacheProviders.has(providerId)) continue

    models.push(...buildModelInfos(providerId, provider.name ?? providerId, provider.models))
  }
  return models
}

/**
 * Discover available OpenCode models by reading the local cache and config.
 * A model is included if its provider has OAuth tokens, an env var set, or is
 * a custom provider defined in opencode.json.
 */
export function discoverModels(): ModelInfo[] {
  const { models, availableProviders } = discoverCacheModels()
  const configModels = discoverConfigModels(availableProviders)

  // Merge config models, deduplicating by id
  const seen = new Set(models.map((m) => m.id))
  for (const model of configModels) {
    if (!seen.has(model.id)) {
      models.push(model)
      seen.add(model.id)
    }
  }

  return models
}
