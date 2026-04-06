// OpenCode agent provider: spawns `opencode run` per prompt with stdin/stdout NDJSON.
// Sessions persist to disk via `-s <session>`, enabling idle suspension and resume.
//
// Each prompt spawns a fresh `opencode run` process. The process exits after
// completing the turn; the next prompt re-invokes with the same session ID.

import { Effect } from "effect"
import { PROVIDER_DISPLAY_NAMES } from "@tangerine/shared"
import { createLogger, truncate } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import type { AgentFactory, AgentHandle, AgentEvent, AgentStartContext, PromptImage, ModelInfo, ProviderMetadata } from "./provider"
import { parseNdjsonStream } from "./ndjson"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { killProcessTree, killProcessTreeEscalated } from "./process-tree"
import { scanClaudeSkills } from "./skill-scanner"

const log = createLogger("opencode-provider")
export const OPENCODE_PROVIDER_METADATA: ProviderMetadata = {
  displayName: PROVIDER_DISPLAY_NAMES.opencode,
  skills: {
    directory: join(homedir(), ".claude", "skills"),
  },
}

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

const OPENCODE_SYSTEM_AGENT = "tangerine-system"

export function buildOpenCodeSystemAgent(prompt: string): Record<string, unknown> {
  return {
    description: "Tangerine system prompt agent",
    mode: "primary",
    prompt,
  }
}

async function ensureOpenCodeConfig(configDir = join(homedir(), ".config")): Promise<string> {
  const providerConfigDir = join(configDir, "opencode")
  const providerConfigPath = join(providerConfigDir, "opencode.json")

  try {
    const file = Bun.file(providerConfigPath)
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
      await Bun.write(providerConfigPath, JSON.stringify(merged, null, 2) + "\n")
    } else {
      await Bun.write(providerConfigPath, JSON.stringify(OPENCODE_CONFIG, null, 2) + "\n")
    }
    log.info("OpenCode config ensured", { path: providerConfigPath })
  } catch (err) {
    log.warn("Failed to write OpenCode config, permissions may prompt", { error: String(err) })
  }
  return providerConfigPath
}

async function prepareOpenCodeSessionConfig(systemPrompt?: string): Promise<{
  env?: Record<string, string>
  agentName?: string
  cleanup(): void
}> {
  if (!systemPrompt) {
    await ensureOpenCodeConfig()
    return { cleanup() {} }
  }

  const configRoot = mkdtempSync(join(tmpdir(), "tangerine-opencode-"))
  const providerConfigDir = join(configRoot, "opencode")
  mkdirSync(providerConfigDir, { recursive: true })
  await ensureOpenCodeConfig(configRoot)

  const configFile = Bun.file(join(providerConfigDir, "opencode.json"))
  const existing = await configFile.exists()
    ? JSON.parse(await configFile.text()) as Record<string, unknown>
    : {}
  const agents = (existing.agent ?? {}) as Record<string, unknown>
  const merged = {
    ...existing,
    $schema: "https://opencode.ai/config.json",
    agent: {
      ...agents,
      [OPENCODE_SYSTEM_AGENT]: buildOpenCodeSystemAgent(systemPrompt),
    },
  }
  await Bun.write(join(providerConfigDir, "opencode.json"), JSON.stringify(merged, null, 2) + "\n")

  return {
    env: { XDG_CONFIG_HOME: configRoot },
    agentName: OPENCODE_SYSTEM_AGENT,
    cleanup() {
      rmSync(configRoot, { recursive: true, force: true })
    },
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
// Adapter: `--format json` NDJSON events → internal event format
// ---------------------------------------------------------------------------
// `opencode run --format json` outputs simplified event types (text, tool_use,
// step_start, step_finish, reasoning, error) while the event processor expects
// the internal SSE format (message.part.updated, session.status, etc.).
// This adapter converts back so we can reuse the tested processor logic.

export function adaptRunJsonEvent(raw: Record<string, unknown>): Record<string, unknown>[] {
  const type = raw.type as string | undefined
  if (!type) return []

  const part = raw.part as Record<string, unknown> | undefined

  switch (type) {
    // text, tool_use, reasoning all map to message.part.updated with the part object
    case "text":
    case "tool_use":
    case "reasoning":
      if (!part) return []
      return [{ type: "message.part.updated", properties: { part } }]

    case "step_start":
      return [{ type: "session.status", properties: { status: { type: "busy" } } }]

    case "step_finish": {
      // Reconstruct message.updated completion event to trigger narration + cleanup
      if (!part) return []
      const messageId = part.messageID ?? part.id
      return [{
        type: "message.updated",
        properties: {
          info: {
            id: messageId,
            role: "assistant",
            time: { completed: raw.timestamp ?? Date.now() },
          },
        },
      }]
    }

    case "error":
      return [{ type: "session.error", properties: { error: raw.error } }]

    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Provider implementation — subprocess per prompt
// ---------------------------------------------------------------------------

export function createOpenCodeProvider(): AgentFactory {
  return {
    metadata: OPENCODE_PROVIDER_METADATA,
    listModels() {
      return discoverModels()
    },
    start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
      const taskLog = log.child({ taskId: ctx.taskId })

      return Effect.tryPromise({
        try: async () => {
          let sessionConfig = await prepareOpenCodeSessionConfig(ctx.systemPrompt)

          // Session ID: use the real session ID from a previous run if resuming,
          // otherwise null until we capture it from the first NDJSON event.
          // opencode run -s <id> requires a real session ID (ses_...) — passing
          // a random UUID causes it to exit silently with code 0 and no output.
          let sessionId = ctx.resumeSessionId ?? null
          taskLog.info("OpenCode session initialized", { sessionId, isResume: !!ctx.resumeSessionId })

          const subscribers = new Set<(e: AgentEvent) => void>()
          let shutdownCalled = false
          let currentProc: ReturnType<typeof Bun.spawn> | null = null
          let currentParser: { stop(): void } | null = null

          // Track active model for CLI flags
          // Note: opencode run does not support --reasoning-effort; it's a per-provider config
          let activeModel = ctx.model ?? ""
          let activeAgent = sessionConfig.agentName
          // Track last spawned PID so cleanup can kill orphaned processes after server restart
          let lastPid: number | null = null

          const emit = (event: AgentEvent) => {
            for (const cb of subscribers) cb(event)
          }

          // Event processor is created lazily once we have a real session ID
          let eventProcessor: ReturnType<typeof createOpenCodeEventProcessor> | null = null
          function getOrCreateProcessor(sid: string) {
            if (!eventProcessor) {
              eventProcessor = createOpenCodeEventProcessor(sid, {
                emit,
              })
            }
            return eventProcessor
          }

          // Emit initial idle so the task system knows we're ready
          queueMicrotask(() => emit({ kind: "status", status: "idle" }))

          /** Build CLI args for `opencode run` */
          function buildArgs(): string[] {
            const args = ["opencode", "run", "--format", "json"]
            // Only pass -s when we have a real session ID from a previous run
            if (sessionId) {
              args.push("-s", sessionId)
            }
            if (activeModel) {
              args.push("-m", activeModel)
            }
            if (activeAgent) {
              args.push("--agent", activeAgent)
            }
            return args
          }

          const handle: AgentHandle = {
            sendPrompt(text: string, images?: PromptImage[]) {
              return Effect.tryPromise({
                try: async () => {
                  if (shutdownCalled) throw new Error("Agent shut down")

                  // Wait for previous process to finish before spawning a new one.
                  // Tangerine's prompt queue already serializes prompts per task,
                  // so this is a safety net — don't kill in-flight work.
                  if (currentProc) {
                    taskLog.debug("Waiting for previous opencode run to finish")
                    await currentProc.exited
                    currentParser?.stop()
                    currentProc = null
                    currentParser = null
                  }

                  // Write images to temp files for -f/--file attachment
                  const tempFiles: string[] = []
                  if (images && images.length > 0) {
                    for (let i = 0; i < images.length; i++) {
                      const img = images[i]!
                      const ext = img.mediaType.split("/")[1]?.replace("+xml", "") ?? "png"
                      const tmpPath = join(ctx.workdir, `.tangerine-img-${i}.${ext}`)
                      const buf = Buffer.from(img.data, "base64")
                      await Bun.write(tmpPath, buf)
                      tempFiles.push(tmpPath)
                    }
                  }

                  const args = buildArgs()
                  // Attach image files via -f flag
                  for (const f of tempFiles) {
                    args.push("-f", f)
                  }

                  taskLog.debug("Spawning opencode run", {
                    args: args.join(" "),
                    textLength: text.length,
                    hasImages: tempFiles.length > 0,
                    imageCount: tempFiles.length,
                  })

                  const proc = Bun.spawn(args, {
                    cwd: ctx.workdir,
                    stdin: "pipe",
                    stdout: "pipe",
                    stderr: "pipe",
                    env: { ...process.env, ...ctx.env, ...sessionConfig.env },
                  })
                  currentProc = proc
                  lastPid = proc.pid

                  emit({ kind: "status", status: "working" })

                  // Check exit code when the process finishes to detect failures
                  proc.exited.then((exitCode) => {
                    if (exitCode !== 0 && exitCode !== null && !shutdownCalled) {
                      taskLog.error("opencode run exited with error", { exitCode, pid: proc.pid })
                      emit({ kind: "error", message: `opencode run exited with code ${exitCode}` })
                    }
                    // Clean up temp image files
                    for (const f of tempFiles) {
                      try { unlinkSync(f) } catch { /* already gone */ }
                    }
                  })

                  // Parse NDJSON from stdout — adapt --format json events to
                  // internal format before feeding to the event processor
                  const parser = parseNdjsonStream(
                    proc.stdout as ReadableStream<Uint8Array>,
                    {
                      onLine: (data) => {
                        const raw = data as Record<string, unknown>

                        // Capture the real session ID from the first event
                        if (!sessionId && typeof raw.sessionID === "string") {
                          sessionId = raw.sessionID
                          taskLog.info("Captured OpenCode session ID", { sessionId })
                        }

                        const processor = getOrCreateProcessor(sessionId ?? ctx.taskId)
                        const adapted = adaptRunJsonEvent(raw)
                        for (const event of adapted) {
                          processor.process(event)
                        }
                      },
                      onError: (err) => {
                        if (!shutdownCalled) {
                          taskLog.error("stdout parse error", { error: err.message })
                          emit({ kind: "error", message: err.message })
                        }
                      },
                      onEnd: () => {
                        // Process completed its turn — clear refs so isAlive()
                        // doesn't probe the exited PID between prompts
                        currentProc = null
                        currentParser = null
                        if (!shutdownCalled) {
                          taskLog.debug("opencode run stdout ended")
                          // Feed synthetic idle to processor so it promotes
                          // narration → assistant message before emitting idle
                          const processor = getOrCreateProcessor(sessionId ?? ctx.taskId)
                          processor.process({
                            type: "session.status",
                            properties: { status: { type: "idle" } },
                          })
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
                catch: (e) => {
                  taskLog.error("Failed to spawn opencode run", { error: String(e) })
                  return new PromptError({ message: `Failed to send prompt: ${e}`, taskId: ctx.taskId })
                },
              })
            },

            abort() {
              return Effect.try({
                try: () => {
                  if (currentProc) {
                    killProcessTree(currentProc.pid, "SIGTERM")
                  }
                },
                catch: (e) =>
                  new AgentError({ message: `Abort failed: ${e}`, taskId: ctx.taskId }),
              })
            },

            setSystemPrompt(text: string) {
              return Effect.tryPromise({
                try: async () => {
                  sessionConfig.cleanup()
                  sessionConfig = await prepareOpenCodeSessionConfig(text)
                  activeAgent = sessionConfig.agentName
                  return !!activeAgent
                },
                catch: (e) =>
                  new AgentError({ message: `Failed to set system prompt: ${e}`, taskId: ctx.taskId }),
              })
            },

            updateConfig(config: import("./provider").AgentConfig) {
              // Model is passed per-prompt via -m flag — just update the tracked value.
              // Reasoning effort is not supported by `opencode run` CLI — silently accepted.
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
                  killProcessTreeEscalated(currentProc.pid)
                  currentProc = null
                }
                currentParser = null
                sessionConfig.cleanup()
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

            getSkills() {
              return scanClaudeSkills()
            },
          }

          // Attach metadata so callers can read session info
          Object.defineProperty(handle, "__meta", {
            get: () => ({
              sessionId,
              agentPort: null as number | null,
            }),
          })
          // Attach PID getter — returns last spawned PID for DB persistence / cleanup.
          // Note: this is null until the first prompt spawns a process. For per-prompt
          // providers, orphan processes are short-lived (exit on turn completion), so
          // the DB PID is a best-effort fallback rather than a reliable kill target.
          Object.defineProperty(handle, "__pid", {
            get: () => lastPid,
          })

          ;(handle as { __taskId?: string }).__taskId = ctx.taskId

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
