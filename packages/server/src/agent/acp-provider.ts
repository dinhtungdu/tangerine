import { Effect } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { createLogger } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import { killDescendants, killProcessTreeEscalated } from "./process-tree"
import type { AgentConfigOption, AgentContentBlock, AgentPlanEntry } from "@tangerine/shared"
import type { AgentEvent, AgentFactory, AgentHandle, AgentStartContext, PromptImage, AgentMetadata } from "./provider"

const log = createLogger("acp-provider")
const ACP_PROTOCOL_VERSION = 1
const DEFAULT_ACP_COMMAND = "acp-agent"

export interface AcpCommandConfig {
  shellCommand: string
  checkCommand: string
}

export interface AcpProviderConfig {
  id: string
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface AcpTextContent {
  type: "text"
  text: string
}

export interface AcpImageContent {
  type: "image"
  mimeType: PromptImage["mediaType"]
  data: string
}

export type AcpPromptBlock = AcpTextContent | AcpImageContent

export interface PermissionOption {
  optionId: string
  name: string
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number | string | null
  method: string
  params?: unknown
}

interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

type RequestResolver = {
  resolve(value: unknown): void
  reject(error: Error): void
}

interface AcpAgentCapabilities {
  loadSession: boolean
  imagePrompts: boolean
  resume: boolean
  close: boolean
}

export const ACP_AGENT_METADATA: AgentMetadata = {
  displayName: "ACP",
  abbreviation: "ACP",
  cliCommand: resolveAcpCommand(process.env).checkCommand,
  skills: {
    directory: join(homedir(), ".config", "acp", "skills"),
  },
}

export function resolveAcpCommand(env: Record<string, string | undefined>): AcpCommandConfig {
  const shellCommand = (env.TANGERINE_ACP_COMMAND?.trim() || DEFAULT_ACP_COMMAND)
  return { shellCommand, checkCommand: extractCheckCommand(shellCommand) }
}

function resolveProviderCommand(config: AcpProviderConfig | undefined, env: Record<string, string | undefined>): AcpCommandConfig {
  if (!config) return resolveAcpCommand(env)
  const shellCommand = [config.command, ...(config.args ?? [])].join(" ").trim()
  return { shellCommand, checkCommand: extractCheckCommand(shellCommand) }
}

function extractCheckCommand(shellCommand: string): string {
  const match = shellCommand.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? DEFAULT_ACP_COMMAND
}

export function buildAcpPromptBlocks(text: string, images: PromptImage[] = [], supportsImages: boolean): AcpPromptBlock[] {
  if (images.length > 0 && !supportsImages) {
    throw new Error("ACP agent does not support image prompts")
  }

  const blocks: AcpPromptBlock[] = []
  if (text.length > 0) blocks.push({ type: "text", text })
  for (const image of images) {
    blocks.push({ type: "image", mimeType: image.mediaType, data: image.data })
  }
  return blocks
}

export function selectPermissionOption(options: PermissionOption[]): string | null {
  const allow = options.find((option) => option.kind === "allow_once" || option.kind === "allow_always")
  return allow?.optionId ?? options[0]?.optionId ?? null
}

export function createAcpEventMapper(): {
  mapSessionUpdate(update: Record<string, unknown>): AgentEvent[]
  flushAssistantMessage(): AgentEvent[]
} {
  let assistantBuffer = ""
  const toolNames = new Map<string, string>()

  return {
    mapSessionUpdate(update: Record<string, unknown>): AgentEvent[] {
      const kind = stringField(update, "sessionUpdate")
      if (!kind) return []

      switch (kind) {
        case "agent_message_chunk": {
          const text = textFromContent(update.content)
          if (text) {
            assistantBuffer += text
            return [{ kind: "message.streaming", content: text, messageId: stringField(update, "messageId") }]
          }
          const block = contentBlockFromContent(update.content)
          return block ? [{ kind: "content.block", block }] : []
        }

        case "agent_thought_chunk": {
          const text = textFromContent(update.content)
          return text ? [{ kind: "thinking", content: truncate(text, 500) }] : []
        }

        case "user_message_chunk": {
          const text = textFromContent(update.content)
          return text ? [{ kind: "message.complete", role: "user", content: text, messageId: stringField(update, "messageId") }] : []
        }

        case "tool_call": {
          const toolCallId = stringField(update, "toolCallId")
          const title = stringField(update, "title") ?? stringField(update, "kind") ?? toolCallId ?? "tool"
          if (toolCallId) toolNames.set(toolCallId, title)
          return [{
            kind: "tool.start",
            toolName: title,
            toolInput: stringifyForEvent(update.rawInput),
          }]
        }

        case "tool_call_update": {
          const toolCallId = stringField(update, "toolCallId")
          const status = stringField(update, "status")
          const contentBlockEvents = contentBlocksFromToolContent(update.content)
          if (status !== "completed" && status !== "failed") return contentBlockEvents
          const toolName = (toolCallId ? toolNames.get(toolCallId) : undefined) ?? stringField(update, "title") ?? toolCallId ?? "tool"
          if (toolCallId) toolNames.delete(toolCallId)
          const result = stringifyForEvent(update.rawOutput) ?? stringifyToolContent(update.content)
          return [
            ...contentBlockEvents,
            {
              kind: "tool.end",
              toolName,
              toolResult: status === "failed" && result ? `[failed] ${result}` : result,
            },
          ]
        }

        case "plan": {
          const entries = parsePlanEntries(update.entries)
          const lines = entries
            .map((entry) => `- [${entry.status ?? "pending"}/${entry.priority ?? "medium"}] ${entry.content}`)
            .filter((line) => line.trim().length > 0)
          return lines.length > 0
            ? [
              { kind: "thinking", content: `Plan:\n${lines.join("\n")}` },
              { kind: "plan", entries },
            ]
            : []
        }

        case "usage_update": {
          const used = numberField(update, "used")
          return used && used > 0 ? [{ kind: "usage", contextTokens: used }] : []
        }

        case "session_info_update": {
          const title = stringOrNullField(update, "title")
          const updatedAt = stringOrNullField(update, "updatedAt")
          const metadata = isRecord(update._meta) ? update._meta : undefined
          if (title === undefined && updatedAt === undefined && metadata === undefined) return []
          return [{
            kind: "session.info",
            ...(title !== undefined ? { title } : {}),
            ...(updatedAt !== undefined ? { updatedAt } : {}),
            ...(metadata !== undefined ? { metadata } : {}),
          }]
        }

        case "config_option_update": {
          return [{ kind: "config.options", options: parseConfigOptions(update.configOptions) }]
        }

        default:
          return []
      }
    },

    flushAssistantMessage(): AgentEvent[] {
      if (!assistantBuffer) return []
      const content = assistantBuffer
      assistantBuffer = ""
      return [{ kind: "message.complete", role: "assistant", content }]
    },
  }
}

export function createAcpProvider(config?: AcpProviderConfig): AgentFactory {
  const command = resolveProviderCommand(config, process.env)
  return {
    metadata: {
      ...ACP_AGENT_METADATA,
      displayName: config?.name ?? ACP_AGENT_METADATA.displayName,
      abbreviation: config?.name ?? ACP_AGENT_METADATA.abbreviation,
      cliCommand: command.checkCommand,
    },
    start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
      return Effect.tryPromise({
        try: () => startAcpSession(ctx, config),
        catch: (cause) => new SessionStartError({
          message: `ACP start failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          taskId: ctx.taskId,
          phase: "start-acp",
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        }),
      })
    },
  }
}

async function startAcpSession(ctx: AgentStartContext, config?: AcpProviderConfig): Promise<AgentHandle> {
  const taskLog = log.child({ taskId: ctx.taskId })
  const command = resolveProviderCommand(config, process.env)
  const subscribers = new Set<(event: AgentEvent) => void>()
  let shutdownCalled = false
  let sessionId: string | null = null
  let configOptions: AgentConfigOption[] = []
  let capabilities: AcpAgentCapabilities = {
    loadSession: false,
    imagePrompts: false,
    resume: false,
    close: false,
  }

  const emit = (event: AgentEvent) => {
    for (const subscriber of subscribers) subscriber(event)
  }

  const emitMapped = (event: AgentEvent) => {
    if (event.kind === "config.options") configOptions = event.options
    emit(event)
  }

  const applyConfigOptions = (value: unknown, shouldEmit: boolean) => {
    const parsed = configOptionsFromResponse(value)
    if (!parsed) return
    configOptions = parsed
    if (shouldEmit) emit({ kind: "config.options", options: configOptions })
  }

  const mapper = createAcpEventMapper()
  const proc = Bun.spawn(["bash", "-lc", command.shellCommand], {
    cwd: ctx.workdir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...config?.env, ...ctx.env },
  })

  taskLog.info("ACP agent spawned", { pid: proc.pid, command: command.checkCommand })

  const rpc = new AcpRpcConnection({
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    write: (line) => {
      proc.stdin.write(line)
      proc.stdin.flush()
    },
    onNotification: (method, params) => {
      if (method !== "session/update" || !isRecord(params)) return
      const update = params.update
      if (!isRecord(update)) return
      for (const event of mapper.mapSessionUpdate(update)) emitMapped(event)
    },
    onRequest: async (method, params) => {
      if (method !== "session/request_permission" || !isRecord(params)) {
        throw new Error(`Unsupported ACP client request: ${method}`)
      }
      const options = Array.isArray(params.options)
        ? params.options.filter(isPermissionOption)
        : []
      const optionId = selectPermissionOption(options)
      if (!optionId) return { outcome: { outcome: "cancelled" } }
      const selected = options.find((option) => option.optionId === optionId)
      if (selected) {
        const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
        emit({
          kind: "permission.decision",
          toolName: stringField(toolCall, "title") ?? stringField(toolCall, "kind") ?? stringField(toolCall, "toolCallId"),
          optionId: selected.optionId,
          optionName: selected.name,
          optionKind: selected.kind,
        })
      }
      return { outcome: { outcome: "selected", optionId } }
    },
    onError: (error) => {
      if (!shutdownCalled) emit({ kind: "error", message: error.message })
    },
    onEnd: () => {
      if (!shutdownCalled) emit({ kind: "status", status: "idle" })
    },
  })

  readStderr(proc.stderr as ReadableStream<Uint8Array>, (text) => taskLog.debug("acp stderr", { text }))

  const initResult = await rpc.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "tangerine", title: "Tangerine", version: "0.0.8" },
  })
  capabilities = parseCapabilities(initResult)

  if (ctx.resumeSessionId && capabilities.resume) {
    try {
      const resumeResult = await rpc.request("session/resume", {
        sessionId: ctx.resumeSessionId,
        cwd: ctx.workdir,
        mcpServers: [],
      })
      applyConfigOptions(resumeResult, false)
      sessionId = ctx.resumeSessionId
    } catch (error) {
      taskLog.warn("ACP session/resume failed", { sessionId: ctx.resumeSessionId, error: String(error) })
    }
  }

  if (!sessionId && ctx.resumeSessionId && capabilities.loadSession) {
    try {
      const loadResult = await rpc.request("session/load", {
        sessionId: ctx.resumeSessionId,
        cwd: ctx.workdir,
        mcpServers: [],
      })
      applyConfigOptions(loadResult, false)
      sessionId = ctx.resumeSessionId
    } catch (error) {
      taskLog.warn("ACP session/load failed", { sessionId: ctx.resumeSessionId, error: String(error) })
    }
  }

  if (!sessionId) {
    const newSession = await rpc.request("session/new", {
      cwd: ctx.workdir,
      mcpServers: [],
    })
    if (!isRecord(newSession) || typeof newSession.sessionId !== "string") {
      throw new Error("ACP session/new did not return sessionId")
    }
    sessionId = newSession.sessionId
    applyConfigOptions(newSession, false)
  }

  emit({ kind: "status", status: "idle" })

  const handle: AgentHandle = {
    sendPrompt(text: string, images?: PromptImage[]) {
      return Effect.tryPromise({
        try: async () => {
          if (shutdownCalled) return
          if (!sessionId) throw new Error("ACP session is not ready")
          const prompt = buildAcpPromptBlocks(text, images ?? [], capabilities.imagePrompts)
          emit({ kind: "status", status: "working" })
          rpc.request("session/prompt", { sessionId, prompt })
            .then((response) => {
              for (const event of mapper.flushAssistantMessage()) emit(event)
              const usage = parsePromptUsage(response)
              if (usage) emit(usage)
              emit({ kind: "status", status: "idle" })
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error)
              emit({ kind: "error", message })
              emit({ kind: "status", status: "idle" })
            })
        },
        catch: (cause) => new PromptError({
          message: `ACP prompt failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          taskId: ctx.taskId,
          cause,
        }),
      })
    },

    abort() {
      return Effect.try({
        try: () => {
          if (!sessionId || shutdownCalled) return
          killDescendants(proc.pid, "SIGTERM")
          rpc.notify("session/cancel", { sessionId })
        },
        catch: (cause) => new AgentError({
          message: `ACP abort failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          taskId: ctx.taskId,
          cause,
        }),
      })
    },

    subscribe(onEvent: (event: AgentEvent) => void) {
      subscribers.add(onEvent)
      if (configOptions.length > 0) onEvent({ kind: "config.options", options: configOptions })
      return {
        unsubscribe() {
          subscribers.delete(onEvent)
        },
      }
    },

    shutdown() {
      return Effect.sync(() => {
        shutdownCalled = true
        if (sessionId && capabilities.close) {
          rpc.request("session/close", { sessionId }).catch(() => undefined)
        } else if (sessionId) {
          rpc.notify("session/cancel", { sessionId })
        }
        rpc.stop()
        subscribers.clear()
        try {
          proc.stdin.end()
        } catch {
          // stdin may already be closed
        }
        killProcessTreeEscalated(proc.pid)
      })
    },

    updateConfig(configUpdate) {
      return Effect.tryPromise({
        try: async () => {
          if (!sessionId || shutdownCalled) return false
          let changed = false
          if (configUpdate.model !== undefined) {
            const applied = await setConfigOptionByCategory(rpc, sessionId, configOptions, "model", configUpdate.model, (options) => {
              configOptions = options
              emit({ kind: "config.options", options })
            })
            if (!applied) return false
            changed = true
          }
          if (configUpdate.reasoningEffort !== undefined) {
            const applied = await setConfigOptionByCategory(rpc, sessionId, configOptions, "thought_level", configUpdate.reasoningEffort, (options) => {
              configOptions = options
              emit({ kind: "config.options", options })
            })
            if (!applied) return false
            changed = true
          }
          if (configUpdate.mode !== undefined) {
            const applied = await setConfigOptionByCategory(rpc, sessionId, configOptions, "mode", configUpdate.mode, (options) => {
              configOptions = options
              emit({ kind: "config.options", options })
            })
            if (!applied) return false
            changed = true
          }
          return changed
        },
        catch: (cause) => new AgentError({
          message: `ACP config update failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          taskId: ctx.taskId,
          cause,
        }),
      })
    },

    isAlive() {
      try {
        process.kill(proc.pid, 0)
        return true
      } catch {
        return false
      }
    },

    getSkills() {
      return []
    },

    getConfigOptions() {
      return configOptions
    },
  }

  Object.defineProperty(handle, "__meta", {
    get: () => ({ sessionId, agentPort: null as number | null }),
  })
  ;(handle as { __pid?: number }).__pid = proc.pid
  ;(handle as { __taskId?: string }).__taskId = ctx.taskId

  return handle
}

class AcpRpcConnection {
  private readonly pending = new Map<string, RequestResolver>()
  private nextId = 0
  private stopped = false
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private buffer = ""

  constructor(private readonly options: {
    stdout: ReadableStream<Uint8Array>
    write(line: string): void
    onNotification(method: string, params: unknown): void
    onRequest(method: string, params: unknown): Promise<unknown>
    onError(error: Error): void
    onEnd(): void
  }) {
    this.reader = options.stdout.getReader()
    this.pump()
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.nextId
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject })
    })
    this.send(message)
    return promise
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })
  }

  stop(): void {
    this.stopped = true
    this.reader.cancel().catch(() => undefined)
    for (const resolver of this.pending.values()) {
      resolver.reject(new Error("ACP connection stopped"))
    }
    this.pending.clear()
  }

  private send(message: JsonRpcMessage): void {
    if (this.stopped) throw new Error("ACP connection is closed")
    this.options.write(`${JSON.stringify(message)}\n`)
  }

  private async pump(): Promise<void> {
    try {
      while (!this.stopped) {
        const { done, value } = await this.reader.read()
        if (done) break
        this.buffer += this.decoder.decode(value, { stream: true })
        this.drainBuffer()
      }
    } catch (error) {
      if (!this.stopped) this.options.onError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      if (!this.stopped && this.buffer.trim()) this.processLine(this.buffer.trim())
      if (!this.stopped) this.options.onEnd()
    }
  }

  private drainBuffer(): void {
    let newlineIndex = this.buffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line) this.processLine(line)
      newlineIndex = this.buffer.indexOf("\n")
    }
  }

  private processLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(parsed)) return

    if ("id" in parsed && ("result" in parsed || "error" in parsed) && typeof parsed.method !== "string") {
      this.handleResponse(parsed)
      return
    }

    if (typeof parsed.method === "string" && "id" in parsed) {
      this.handleRequest(parsed)
      return
    }

    if (typeof parsed.method === "string") {
      this.options.onNotification(parsed.method, parsed.params)
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = requestIdToKey(message.id)
    if (!id) return
    const resolver = this.pending.get(id)
    if (!resolver) return
    this.pending.delete(id)

    if (isRecord(message.error)) {
      resolver.reject(new Error(stringField(message.error, "message") ?? "ACP request failed"))
      return
    }
    resolver.resolve(message.result)
  }

  private handleRequest(message: Record<string, unknown>): void {
    const id = message.id
    const method = stringField(message, "method")
    if (!method) return
    this.options.onRequest(method, message.params)
      .then((result) => this.send({ jsonrpc: "2.0", id: id as number | string | null, result }))
      .catch((error: unknown) => {
        const messageText = error instanceof Error ? error.message : String(error)
        this.send({ jsonrpc: "2.0", id: id as number | string | null, error: { code: -32603, message: messageText } })
      })
  }
}

async function setConfigOptionByCategory(
  rpc: AcpRpcConnection,
  sessionId: string,
  options: AgentConfigOption[],
  category: string,
  value: string,
  onOptions: (options: AgentConfigOption[]) => void,
): Promise<boolean> {
  const option = options.find((entry) => entry.category === category)
  if (!option) return false
  if (!option.options.some((entry) => entry.value === value)) return false
  const response = await rpc.request("session/set_config_option", {
    sessionId,
    configId: option.id,
    value,
  })
  const updated = configOptionsFromResponse(response)
  if (updated) onOptions(updated)
  return true
}

function configOptionsFromResponse(value: unknown): AgentConfigOption[] | null {
  if (!isRecord(value) || !("configOptions" in value)) return null
  return parseConfigOptions(value.configOptions)
}

function parseConfigOptions(value: unknown): AgentConfigOption[] {
  if (!Array.isArray(value)) return []
  const options: AgentConfigOption[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = stringField(entry, "id")
    const name = stringField(entry, "name")
    const type = stringField(entry, "type")
    const currentValue = stringField(entry, "currentValue")
    if (!id || !name || !type || currentValue === undefined) continue
    const values = parseConfigOptionValues(entry.options)
    options.push({
      id,
      name,
      ...(stringField(entry, "description") ? { description: stringField(entry, "description") } : {}),
      ...(stringField(entry, "category") ? { category: stringField(entry, "category") } : {}),
      type,
      currentValue,
      options: values,
    })
  }
  return options
}

function parseConfigOptionValues(value: unknown): AgentConfigOption["options"] {
  if (!Array.isArray(value)) return []
  const values: AgentConfigOption["options"] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const optionValue = stringField(entry, "value")
    const name = stringField(entry, "name")
    if (!optionValue || !name) continue
    values.push({
      value: optionValue,
      name,
      ...(stringField(entry, "description") ? { description: stringField(entry, "description") } : {}),
    })
  }
  return values
}

function contentBlockFromContent(content: unknown): AgentContentBlock | null {
  if (!isRecord(content)) return null
  const type = stringField(content, "type")
  return type ? { ...content, type } : null
}

function contentBlocksFromToolContent(content: unknown): AgentEvent[] {
  if (!Array.isArray(content)) return []
  const events: AgentEvent[] = []
  for (const entry of content) {
    if (!isRecord(entry)) continue
    const type = stringField(entry, "type")
    if (type === "content") {
      const block = contentBlockFromContent(entry.content)
      if (block && block.type !== "text") events.push({ kind: "content.block", block })
      continue
    }
    if (type === "diff" || type === "terminal") {
      events.push({ kind: "content.block", block: { ...entry, type } })
    }
  }
  return events
}

function parsePlanEntries(value: unknown): AgentPlanEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((entry) => {
      const content = stringField(entry, "content") ?? ""
      return {
        content,
        ...(stringField(entry, "priority") ? { priority: stringField(entry, "priority") } : {}),
        ...(stringField(entry, "status") ? { status: stringField(entry, "status") } : {}),
      }
    })
    .filter((entry) => entry.content.trim().length > 0)
}

function parseCapabilities(value: unknown): AcpAgentCapabilities {
  const result = isRecord(value) ? value : {}
  const agentCapabilities = isRecord(result.agentCapabilities) ? result.agentCapabilities : {}
  const promptCapabilities = isRecord(agentCapabilities.promptCapabilities) ? agentCapabilities.promptCapabilities : {}
  const sessionCapabilities = isRecord(agentCapabilities.sessionCapabilities) ? agentCapabilities.sessionCapabilities : {}

  return {
    loadSession: agentCapabilities.loadSession === true,
    imagePrompts: promptCapabilities.image === true,
    resume: isRecord(sessionCapabilities.resume),
    close: isRecord(sessionCapabilities.close),
  }
}

function parsePromptUsage(value: unknown): AgentEvent | null {
  if (!isRecord(value) || !isRecord(value.usage)) return null
  const usage = value.usage
  const inputTokens = numberField(usage, "inputTokens")
  const outputTokens = numberField(usage, "outputTokens")
  const totalTokens = numberField(usage, "totalTokens")
  if (!inputTokens && !outputTokens && !totalTokens) return null
  return {
    kind: "usage",
    inputTokens,
    outputTokens,
    contextTokens: totalTokens,
    cumulative: true,
  }
}

function isPermissionOption(value: unknown): value is PermissionOption {
  if (!isRecord(value)) return false
  const kind = value.kind
  return typeof value.optionId === "string"
    && typeof value.name === "string"
    && (kind === "allow_once" || kind === "allow_always" || kind === "reject_once" || kind === "reject_always")
}

function textFromContent(content: unknown): string | null {
  if (!isRecord(content)) return null
  return content.type === "text" && typeof content.text === "string" ? content.text : null
}

function stringifyToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts = content
    .filter(isRecord)
    .map((entry) => {
      if (entry.type === "content") return textFromContent(entry.content)
      return stringifyForEvent(entry)
    })
    .filter((part): part is string => typeof part === "string" && part.length > 0)
  return parts.length > 0 ? truncate(parts.join("\n"), 500) : undefined
}

function stringifyForEvent(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return truncate(value, 500)
  try {
    return truncate(JSON.stringify(value), 500)
  } catch {
    return undefined
  }
}

function requestIdToKey(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value)
  if (value === null) return "null"
  return null
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function stringOrNullField(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key]
  if (value === null) return null
  return typeof value === "string" ? value : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === "number" ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\u2026`
}

function readStderr(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): void {
  ;(async () => {
    try {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true }).trim()
        if (text) onText(text)
      }
    } catch {
      // stderr may close abruptly
    }
  })()
}
