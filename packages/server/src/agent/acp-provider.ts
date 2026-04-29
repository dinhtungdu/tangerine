import { Effect } from "effect"
import { statSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createLogger } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import { killDescendants, killProcessTreeEscalated } from "./process-tree"
import { isAgentEffortOption, type AgentConfigOption, type AgentContentBlock, type AgentPlanEntry, type AgentSlashCommand } from "@tangerine/shared"
import type { AgentEvent, AgentFactory, AgentHandle, AgentStartContext, PromptImage, AgentMetadata } from "./provider"

const log = createLogger("acp-provider")
const ACP_PROTOCOL_VERSION = 1
const DEFAULT_ACP_COMMAND = "acp-agent"
export const DEFAULT_AGENT_STATUS_IDLE_DEBOUNCE_MS = 300

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

export interface AcpResourceLinkContent {
  type: "resource_link"
  uri: string
  name: string
  title: string
}

export type AcpPromptBlock = AcpTextContent | AcpImageContent | AcpResourceLinkContent

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

export interface AcpAgentCapabilities {
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

export function buildAcpPromptBlocks(text: string, images: PromptImage[] = [], supportsImages: boolean, workdir?: string): AcpPromptBlock[] {
  if (images.length > 0 && !supportsImages) {
    throw new Error("ACP agent does not support image prompts")
  }

  const blocks: AcpPromptBlock[] = []
  if (text.length > 0) blocks.push({ type: "text", text })
  for (const file of extractFileMentionLinks(text, workdir)) blocks.push(file)
  for (const image of images) {
    blocks.push({ type: "image", mimeType: image.mediaType, data: image.data })
  }
  return blocks
}

const FILE_MENTION_TRIGGER_RE = /(^|[\s(])@/g

interface ResolvedFileMention {
  absolutePath: string
  relativePath: string
}

function extractFileMentionLinks(text: string, workdir?: string): AcpResourceLinkContent[] {
  if (!workdir) return []
  const links: AcpResourceLinkContent[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(FILE_MENTION_TRIGGER_RE)) {
    const prefix = match[1] ?? ""
    const triggerStart = (match.index ?? 0) + prefix.length
    const mention = resolveFileMentionSuffix(text.slice(triggerStart + 1), workdir)
    if (!mention || seen.has(mention.absolutePath)) continue
    seen.add(mention.absolutePath)
    links.push({
      type: "resource_link",
      uri: pathToFileURL(mention.absolutePath).href,
      name: basename(mention.absolutePath),
      title: mention.relativePath,
    })
  }
  return links
}

function resolveFileMentionSuffix(suffix: string, workdir: string): ResolvedFileMention | null {
  if (!suffix || /\s/.test(suffix[0] ?? "")) return null
  const lineEnd = suffix.search(/[\r\n]/)
  const lineText = lineEnd === -1 ? suffix : suffix.slice(0, lineEnd)
  for (let end = lineText.length; end > 0; end--) {
    const mentionPath = lineText.slice(0, end)
    const resolved = resolveFileMentionPath(mentionPath, workdir)
    if (resolved) return resolved
  }
  return null
}

function resolveFileMentionPath(mentionPath: string, workdir: string): ResolvedFileMention | null {
  if (!mentionPath || isAbsolute(mentionPath)) return null
  const absolutePath = resolve(workdir, mentionPath)
  const relativePath = relative(workdir, absolutePath)
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return null
  try {
    if (!statSync(absolutePath).isFile()) return null
  } catch {
    return null
  }
  return { absolutePath, relativePath }
}

export function selectPermissionOption(options: PermissionOption[]): string | null {
  const allow = options.find((option) => option.kind === "allow_once" || option.kind === "allow_always")
  return allow?.optionId ?? options[0]?.optionId ?? null
}

const SKIP_PERMISSION_MODE_MATCHES = ["bypasspermissions", "fullaccess", "dangerfullaccess"]

export function selectSkipPermissionsMode(options: AgentConfigOption[]): string | null {
  const modeOption = options.find((option) => option.category === "mode")
  if (!modeOption) return null

  for (const target of SKIP_PERMISSION_MODE_MATCHES) {
    const match = modeOption.options.find((option) =>
      normalizeModeToken(option.value) === target || normalizeModeToken(option.name) === target
    )
    if (match) return match.value
  }

  return null
}

function normalizeModeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

export function createPromptStatusTracker(emit: (status: "idle" | "working") => void, idleDebounceMs = DEFAULT_AGENT_STATUS_IDLE_DEBOUNCE_MS): {
  begin(): number
  end(turnId: number): void
  reset(): void
  isWorking(): boolean
  toolStart(toolCallId: string): void
  toolEnd(toolCallId: string): void
  clearTools(): void
} {
  let nextTurnId = 0
  let visibleStatus: "idle" | "working" = "idle"
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const activeTurns = new Set<number>()
  const activeTools = new Set<string>()
  const turnsPendingIdle = new Set<number>() // Turns waiting for tools to complete

  const clearIdleTimer = () => {
    if (!idleTimer) return
    clearTimeout(idleTimer)
    idleTimer = undefined
  }

  const hasActiveWork = () => activeTurns.size > 0 || activeTools.size > 0 || turnsPendingIdle.size > 0

  const emitWorking = () => {
    clearIdleTimer()
    if (visibleStatus === "working") return
    visibleStatus = "working"
    emit("working")
  }

  const emitIdleNow = () => {
    clearIdleTimer()
    if (visibleStatus === "idle") return
    visibleStatus = "idle"
    emit("idle")
  }

  const maybeEmitIdle = () => {
    if (hasActiveWork() || visibleStatus === "idle" || idleTimer) return
    if (idleDebounceMs <= 0) {
      emitIdleNow()
      return
    }

    // ACP adapters can report final tool updates just after prompt RPC resolves.
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (!hasActiveWork()) emitIdleNow()
    }, idleDebounceMs)
  }

  return {
    begin() {
      const turnId = ++nextTurnId
      activeTurns.add(turnId)
      emitWorking()
      return turnId
    },
    end(turnId: number) {
      if (!activeTurns.delete(turnId)) return
      // If tools still running, defer idle emission until they complete
      if (activeTools.size > 0) {
        turnsPendingIdle.add(turnId)
        return
      }
      maybeEmitIdle()
    },
    reset() {
      activeTurns.clear()
      activeTools.clear()
      turnsPendingIdle.clear()
      emitIdleNow()
    },
    // Used for gating assistant chunks - only check prompt turns, not tools
    isWorking() {
      return activeTurns.size > 0
    },
    toolStart(toolCallId: string) {
      activeTools.add(toolCallId)
      emitWorking()
    },
    toolEnd(toolCallId: string) {
      if (!activeTools.delete(toolCallId)) return
      // Check if any turns were waiting for tools to complete
      if (activeTools.size === 0 && turnsPendingIdle.size > 0) {
        turnsPendingIdle.clear()
      }
      maybeEmitIdle()
    },
    // Clear tool state on prompt error/cancel to prevent stuck "working" state
    clearTools() {
      activeTools.clear()
      if (turnsPendingIdle.size > 0) turnsPendingIdle.clear()
      maybeEmitIdle()
    },
  }
}

export function createAcpEventMapper(): {
  mapSessionUpdate(update: Record<string, unknown>): AgentEvent[]
  flushAssistantMessage(): AgentEvent[]
  flushThoughtMessage(): AgentEvent[]
} {
  let assistantBuffer = ""
  let assistantMessageId: string | undefined
  let thoughtBuffer = ""
  let thoughtMessageId: string | undefined
  let thoughtSequence = 0
  const toolStates = new Map<string, { name: string; input?: string }>()

  return {
    mapSessionUpdate(update: Record<string, unknown>): AgentEvent[] {
      const kind = stringField(update, "sessionUpdate")
      if (!kind) return []

      switch (kind) {
        case "agent_message_chunk": {
          const text = textFromContent(update.content)
          if (text) {
            const incomingMessageId = stringField(update, "messageId")
            const events: AgentEvent[] = []
            if (incomingMessageId && assistantMessageId && incomingMessageId !== assistantMessageId && assistantBuffer) {
              events.push({ kind: "message.complete", role: "assistant", content: assistantBuffer, messageId: assistantMessageId })
              assistantBuffer = ""
              assistantMessageId = undefined
            }
            if (incomingMessageId && !assistantMessageId) assistantMessageId = incomingMessageId
            const chunk = `${paragraphBoundaryPrefix(assistantBuffer, text)}${text}`
            assistantBuffer += chunk
            events.push({ kind: "message.streaming", content: chunk, ...(assistantMessageId ? { messageId: assistantMessageId } : {}) })
            return events
          }
          const block = contentBlockFromContent(update.content)
          return block ? [{ kind: "content.block", block }] : []
        }

        case "agent_thought_chunk": {
          const text = textFromContent(update.content)
          if (!text) return []
          const incomingMessageId = stringField(update, "messageId")
          const events: AgentEvent[] = []
          if (incomingMessageId && thoughtMessageId && incomingMessageId !== thoughtMessageId && thoughtBuffer) {
            events.push({ kind: "thinking.complete", content: thoughtBuffer, messageId: thoughtMessageId })
            thoughtBuffer = ""
            thoughtMessageId = undefined
          }
          if (!thoughtMessageId) {
            thoughtMessageId = incomingMessageId ?? `thought-${++thoughtSequence}`
          }
          thoughtBuffer += text
          events.push({ kind: "thinking.streaming", content: text, messageId: thoughtMessageId })
          return events
        }

        case "user_message_chunk": {
          const text = textFromContent(update.content)
          return text ? [{ kind: "message.complete", role: "user", content: text, messageId: stringField(update, "messageId") }] : []
        }

        case "tool_call": {
          const toolCallId = stringField(update, "toolCallId")
          const title = stringField(update, "title") ?? stringField(update, "kind") ?? toolCallId ?? "tool"
          const toolInput = stringifyForEvent(update.rawInput)
          if (toolCallId) toolStates.set(toolCallId, { name: title, ...(toolInput ? { input: toolInput } : {}) })
          return [{
            kind: "tool.start",
            ...(toolCallId ? { toolCallId } : {}),
            toolName: title,
            toolInput,
          }]
        }

        case "tool_call_update": {
          const toolCallId = stringField(update, "toolCallId")
          const status = stringField(update, "status")
          const contentBlockEvents = contentBlocksFromToolContent(update.content)
          const state = toolCallId ? toolStates.get(toolCallId) : undefined
          const title = stringField(update, "title")
          const toolName = title ?? state?.name ?? toolCallId ?? "tool"
          const toolInput = stringifyForEvent(update.rawInput)
          if (toolCallId && (title || toolInput)) {
            toolStates.set(toolCallId, { name: toolName, ...(toolInput ?? state?.input ? { input: toolInput ?? state?.input } : {}) })
          }
          const result = stringifyForEvent(update.rawOutput) ?? stringifyToolContent(update.content)
          if (status !== "completed" && status !== "failed") {
            const events: AgentEvent[] = [...contentBlockEvents]
            if (toolInput || result || status || title) {
              events.push({
                kind: "tool.update",
                ...(toolCallId ? { toolCallId } : {}),
                toolName,
                ...(toolInput ? { toolInput } : {}),
                ...(result ? { toolResult: result } : {}),
                ...(status === "pending" || status === "in_progress" ? { status: "running" } : {}),
              })
            }
            return events
          }
          if (toolCallId) toolStates.delete(toolCallId)
          return [
            ...contentBlockEvents,
            {
              kind: "tool.end",
              ...(toolCallId ? { toolCallId } : {}),
              toolName,
              toolResult: status === "failed" && result ? `[failed] ${result}` : result,
              status: status === "failed" ? "error" : "success",
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
          const size = numberField(update, "size")
          const usageEvent: AgentEvent = {
            kind: "usage",
            ...(used && used > 0 ? { contextTokens: used } : {}),
            ...(size && size > 0 ? { contextWindowMax: size } : {}),
          }
          return usageEvent.contextTokens || usageEvent.contextWindowMax ? [usageEvent] : []
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

        case "available_commands_update": {
          return [{ kind: "slash.commands", commands: parseAvailableCommands(update.availableCommands) }]
        }

        default:
          return []
      }
    },

    flushAssistantMessage(): AgentEvent[] {
      if (!assistantBuffer) return []
      const content = assistantBuffer
      const messageId = assistantMessageId
      assistantBuffer = ""
      assistantMessageId = undefined
      return [{ kind: "message.complete", role: "assistant", content, ...(messageId ? { messageId } : {}) }]
    },

    flushThoughtMessage(): AgentEvent[] {
      if (!thoughtBuffer) return []
      const content = thoughtBuffer
      const messageId = thoughtMessageId
      thoughtBuffer = ""
      thoughtMessageId = undefined
      return [{ kind: "thinking.complete", content, messageId }]
    },
  }
}

function paragraphBoundaryPrefix(previous: string, next: string): string {
  if (!previous || !next) return ""
  if (/^\s/.test(next)) return ""
  if (!/[.!?]$/.test(previous)) return ""
  if (!/^[A-Z]/.test(next)) return ""
  if (wordCount(lastSentenceFragment(previous)) < 3) return ""
  if (wordCount(firstSentenceFragment(next)) < 2) return ""
  return "\n\n"
}

function lastSentenceFragment(text: string): string {
  const line = text.slice(text.lastIndexOf("\n") + 1)
  const body = line.slice(0, -1)
  const previousBoundary = Math.max(body.lastIndexOf("."), body.lastIndexOf("!"), body.lastIndexOf("?"))
  return body.slice(previousBoundary + 1)
}

function firstSentenceFragment(text: string): string {
  const ends = [text.indexOf("."), text.indexOf("!"), text.indexOf("?"), text.indexOf("\n")]
    .filter((index) => index >= 0)
  const end = ends.length > 0 ? Math.min(...ends) : text.length
  return text.slice(0, end)
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
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
  let lastStatus: "idle" | "working" | null = null
  let sessionId: string | null = null
  let configOptions: AgentConfigOption[] = []
  let slashCommands: AgentSlashCommand[] = []
  let capabilities: AcpAgentCapabilities = {
    loadSession: false,
    imagePrompts: false,
    resume: false,
    close: false,
  }

  // Permission request tracking for ACP agents that ask the client to decide.
  const PERMISSION_TIMEOUT_MS = 120_000 // 2 minutes
  let nextPermissionId = 0
  interface PendingPermission {
    resolve: (result: { outcome: { outcome: string; optionId?: string } }) => void
    timeout: ReturnType<typeof setTimeout>
    options: PermissionOption[]
    toolName?: string
  }
  const pendingPermissions = new Map<string, PendingPermission>()

  const emit = (event: AgentEvent) => {
    if (event.kind === "status") lastStatus = event.status
    for (const subscriber of subscribers) subscriber(event)
  }

  const statusTracker = createPromptStatusTracker((status) => emit({ kind: "status", status }))
  let skipPermissionsPending = ctx.permissionMode === "skipPermissions"
  let skipPermissionsApplyPromise: Promise<void> | null = null

  const tryApplySkipPermissionsMode = async () => {
    if (!skipPermissionsPending || !sessionId) return
    if (skipPermissionsApplyPromise) return skipPermissionsApplyPromise

    skipPermissionsApplyPromise = (async () => {
      if (!skipPermissionsPending || !sessionId) return
      const mode = selectSkipPermissionsMode(configOptions)
      if (!mode) return
      const currentMode = configOptions.find((option) => option.category === "mode")?.currentValue
      if (currentMode === mode) {
        skipPermissionsPending = false
        return
      }
      const applied = await setConfigOptionByCategory(rpc, sessionId, configOptions, "mode", mode, (options) => {
        configOptions = options
        emit({ kind: "config.options", options })
      })
      if (!applied) return
      skipPermissionsPending = false
      taskLog.debug("Applied skipPermissions mode", { mode })
    })().finally(() => {
      skipPermissionsApplyPromise = null
    })

    return skipPermissionsApplyPromise
  }

  const emitMapped = (event: AgentEvent) => {
    if (event.kind === "config.options") {
      configOptions = event.options
      if (skipPermissionsPending) {
        tryApplySkipPermissionsMode().catch((error) => {
          taskLog.warn("Failed to apply skipPermissions mode", { error: String(error) })
        })
      }
    }
    if (event.kind === "slash.commands") slashCommands = event.commands
    // Track tool lifecycle to prevent premature idle emission
    // For tool.end: emit event first, then update tracker (which may emit idle)
    if ((event.kind === "tool.start" || (event.kind === "tool.update" && event.status === "running")) && event.toolCallId) {
      statusTracker.toolStart(event.toolCallId)
      emit(event)
    } else if (event.kind === "tool.end" && event.toolCallId) {
      emit(event)
      statusTracker.toolEnd(event.toolCallId)
    } else {
      emit(event)
    }
  }

  const applyConfigOptions = (value: unknown, shouldEmit: boolean) => {
    const parsed = configOptionsFromAcpResponse(value)
    if (!parsed) return
    configOptions = parsed
    if (shouldEmit) emit({ kind: "config.options", options: configOptions })
  }

  const mapper = createAcpEventMapper()

  const discardBufferedText = () => {
    mapper.flushAssistantMessage()
    mapper.flushThoughtMessage()
  }

  const emitFlushedThoughts = () => {
    for (const event of mapper.flushThoughtMessage()) emit(event)
  }

  const updateModeFromNotification = (update: Record<string, unknown>) => {
    if (stringField(update, "sessionUpdate") !== "current_mode_update") return
    const modeId = stringField(update, "currentModeId") ?? stringField(update, "modeId")
    if (!modeId) return
    const updated = updateLegacyModeOptionValue(configOptions, modeId)
    if (updated === configOptions) return
    configOptions = updated
    emit({ kind: "config.options", options: configOptions })
  }

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
      updateModeFromNotification(update)
      if (isAssistantTextStreamUpdate(update) && !statusTracker.isWorking()) return
      for (const event of mapper.mapSessionUpdate(update)) emitMapped(event)
    },
    onRequest: async (method, params) => {
      if (!isRecord(params)) throw new Error(`Invalid ACP client request params: ${method}`)
      if (method === "session/request_permission") {
        const options = Array.isArray(params.options)
          ? params.options.filter(isPermissionOption)
          : []
        const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
        const toolName = stringField(toolCall, "title") ?? stringField(toolCall, "kind") ?? stringField(toolCall, "toolCallId")
        const toolCallId = stringField(toolCall, "toolCallId")

        // Auto-accept mode (default): immediately select allow option.
        if (ctx.permissionMode !== "prompt") {
          const optionId = selectPermissionOption(options)
          if (!optionId) return { outcome: { outcome: "cancelled" } }
          const selected = options.find((option) => option.optionId === optionId)
          if (selected) {
            emit({
              kind: "permission.decision",
              toolName,
              optionId: selected.optionId,
              optionName: selected.name,
              optionKind: selected.kind,
            })
          }
          return { outcome: { outcome: "selected", optionId } }
        }

        // Manual approval: emit request event and wait for external response
        const requestId = `perm-${++nextPermissionId}`
        emit({
          kind: "permission.request",
          requestId,
          toolName,
          toolCallId,
          options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
        })
        return new Promise<{ outcome: { outcome: string; optionId?: string } }>((resolve) => {
          const timeout = setTimeout(() => {
            pendingPermissions.delete(requestId)
            resolve({ outcome: { outcome: "cancelled" } })
          }, PERMISSION_TIMEOUT_MS)
          pendingPermissions.set(requestId, { resolve, timeout, options, toolName })
        })
      }
      if (method === "fs/read_text_file") return readTextFileForAcp(ctx.workdir, params)
      if (method === "fs/write_text_file") return writeTextFileForAcp(ctx.workdir, params)
      throw new Error(`Unsupported ACP client request: ${method}`)
    },
    onError: (error) => {
      if (!shutdownCalled) emit({ kind: "error", message: error.message })
    },
    onEnd: () => {
      if (!shutdownCalled) {
        emitFlushedThoughts()
        emit({ kind: "status", status: "idle" })
      }
    },
  })

  readStderr(proc.stderr as ReadableStream<Uint8Array>, (text) => taskLog.debug("acp stderr", { text }))

  const initResult = await rpc.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "tangerine", title: "Tangerine", version: "0.0.8" },
  })
  capabilities = parseAcpCapabilities(initResult)

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

  await tryApplySkipPermissionsMode().catch((error) => {
    taskLog.warn("Failed to apply skipPermissions mode", { error: String(error) })
  })

  emit({ kind: "status", status: "idle" })

  const handle: AgentHandle = {
    sendPrompt(text: string, images?: PromptImage[]) {
      return Effect.tryPromise({
        try: async () => {
          if (shutdownCalled) return
          if (!sessionId) throw new Error("ACP session is not ready")
          const prompt = buildAcpPromptBlocks(text, images ?? [], capabilities.imagePrompts, ctx.workdir)
          discardBufferedText()
          const turnId = statusTracker.begin()
          rpc.request("session/prompt", { sessionId, prompt })
            .then((response) => {
              emitFlushedThoughts()
              for (const event of mapper.flushAssistantMessage()) emit(event)
              const usage = parsePromptUsage(response)
              if (usage) emit(usage)
              statusTracker.end(turnId)
            })
            .catch((error: unknown) => {
              emitFlushedThoughts()
              for (const event of mapper.flushAssistantMessage()) emit(event)
              const message = error instanceof Error ? error.message : String(error)
              emit({ kind: "error", message })
              // Clear tool state on error - cancelled/failed prompts may not send terminal tool events
              statusTracker.clearTools()
              statusTracker.end(turnId)
            })
        },
        catch: (cause) => new PromptError({
          message: `ACP prompt failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          taskId: ctx.taskId,
          cause,
        }),
      })
    },

    respondToPermission(requestId: string, optionId: string) {
      const pending = pendingPermissions.get(requestId)
      if (!pending) return
      pendingPermissions.delete(requestId)
      clearTimeout(pending.timeout)
      const selected = pending.options.find((o) => o.optionId === optionId)
      if (selected) {
        emit({
          kind: "permission.decision",
          toolName: pending.toolName,
          optionId: selected.optionId,
          optionName: selected.name,
          optionKind: selected.kind,
        })
        pending.resolve({ outcome: { outcome: "selected", optionId } })
      } else {
        pending.resolve({ outcome: { outcome: "cancelled" } })
      }
    },

    abort(force = false) {
      return Effect.try({
        try: () => {
          if (!sessionId || shutdownCalled) return
          if (force) {
            // Force kill for hung agents that won't respond to RPC
            killDescendants(proc.pid, "SIGTERM")
          }
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
      if (lastStatus) onEvent({ kind: "status", status: lastStatus })
      if (configOptions.length > 0) onEvent({ kind: "config.options", options: configOptions })
      if (slashCommands.length > 0) onEvent({ kind: "slash.commands", commands: slashCommands })
      return {
        unsubscribe() {
          subscribers.delete(onEvent)
        },
      }
    },

    shutdown() {
      return Effect.sync(() => {
        shutdownCalled = true
        // Clear pending permission requests
        for (const [, pending] of pendingPermissions) {
          clearTimeout(pending.timeout)
          pending.resolve({ outcome: { outcome: "cancelled" } })
        }
        pendingPermissions.clear()
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
            const applied = await setConfigOptionByPredicate(rpc, sessionId, configOptions, isAgentEffortOption, configUpdate.reasoningEffort, (options) => {
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

    getSlashCommands() {
      return slashCommands
    },
  }

  Object.defineProperty(handle, "__meta", {
    get: () => ({ sessionId, agentPort: null as number | null }),
  })
  ;(handle as { __pid?: number }).__pid = proc.pid
  ;(handle as { __taskId?: string }).__taskId = ctx.taskId

  return handle
}

export class AcpRpcConnection {
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
      if (!this.stopped) {
        for (const resolver of this.pending.values()) resolver.reject(new Error("ACP connection ended"))
        this.pending.clear()
        this.options.onEnd()
      }
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
  return setConfigOptionByPredicate(rpc, sessionId, options, (entry) => entry.category === category, value, onOptions)
}

async function setConfigOptionByPredicate(
  rpc: AcpRpcConnection,
  sessionId: string,
  options: AgentConfigOption[],
  predicate: (option: AgentConfigOption) => boolean,
  value: string,
  onOptions: (options: AgentConfigOption[]) => void,
): Promise<boolean> {
  const option = options.find(predicate)
  if (!option) return false
  if (!option.options.some((entry) => entry.value === value)) return false

  const response = await rpc.request(configMethodForOption(option), configParamsForOption(option, sessionId, value))
  const updated = configOptionsFromAcpResponse(response) ?? updateConfigOptionValueByPredicate(options, predicate, value)
  onOptions(updated)
  return true
}

function configMethodForOption(option: AgentConfigOption): string {
  if (option.source === "model") return "session/set_model"
  if (option.source === "mode") return "session/set_mode"
  return "session/set_config_option"
}

function configParamsForOption(option: AgentConfigOption, sessionId: string, value: string): Record<string, string> {
  if (option.source === "model") return { sessionId, modelId: value }
  if (option.source === "mode") return { sessionId, modeId: value }
  return { sessionId, configId: option.id, value }
}

function updateLegacyModeOptionValue(options: AgentConfigOption[], value: string): AgentConfigOption[] {
  return updateConfigOptionValueByPredicate(options, (option) => option.source === "mode" || option.category === "mode", value)
}

function updateConfigOptionValueByPredicate(
  options: AgentConfigOption[],
  predicate: (option: AgentConfigOption) => boolean,
  value: string,
): AgentConfigOption[] {
  let changed = false
  const updated = options.map((option) => {
    if (!predicate(option)) return option
    if (option.currentValue === value) return option
    changed = true
    return { ...option, currentValue: value }
  })
  return changed ? updated : options
}

export function configOptionsFromAcpResponse(value: unknown): AgentConfigOption[] | null {
  if (!isRecord(value)) return null
  const options = "configOptions" in value ? parseConfigOptions(value.configOptions) : []
  if (!options.some((option) => option.category === "model")) {
    const modelOption = modelConfigOptionFromResponse(value.models)
    if (modelOption) options.push(modelOption)
  }
  const modeOption = modeConfigOptionFromResponse(value.modes)
  if (modeOption && !options.some((option) => option.category === modeOption.category)) {
    options.push(modeOption)
  }
  return options.length > 0 ? options : null
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
      source: "config_option",
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

function parseAvailableCommands(value: unknown): AgentSlashCommand[] {
  if (!Array.isArray(value)) return []
  const commands: AgentSlashCommand[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const name = stringField(entry, "name")
    if (!name) continue
    const description = stringField(entry, "description") ?? ""
    const input = isRecord(entry.input) ? entry.input : null
    const hint = input ? stringField(input, "hint") : undefined
    commands.push({
      name,
      description,
      ...(hint ? { input: { hint } } : {}),
    })
  }
  return commands
}

function modelConfigOptionFromResponse(value: unknown): AgentConfigOption | null {
  if (!isRecord(value)) return null
  const currentValue = stringField(value, "currentModelId")
  const availableModels = Array.isArray(value.availableModels) ? value.availableModels : []
  if (!currentValue || availableModels.length === 0) return null
  const options = availableModels.flatMap((entry): AgentConfigOption["options"] => {
    if (!isRecord(entry)) return []
    const modelId = stringField(entry, "modelId")
    const name = stringField(entry, "name") ?? modelId
    if (!modelId || !name) return []
    return [{
      value: modelId,
      name,
      ...(stringOrNullField(entry, "description") ? { description: stringOrNullField(entry, "description")! } : {}),
    }]
  })
  if (options.length === 0) return null
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options,
    source: "model",
  }
}

function modeConfigOptionFromResponse(value: unknown): AgentConfigOption | null {
  if (!isRecord(value)) return null
  const currentValue = stringField(value, "currentModeId")
  const availableModes = Array.isArray(value.availableModes) ? value.availableModes : []
  if (!currentValue || availableModes.length === 0) return null
  const options = availableModes.flatMap((entry): AgentConfigOption["options"] => {
    if (!isRecord(entry)) return []
    const modeId = stringField(entry, "id")
    const name = stringField(entry, "name") ?? modeId
    if (!modeId || !name) return []
    return [{
      value: modeId,
      name,
      ...(stringOrNullField(entry, "description") ? { description: stringOrNullField(entry, "description")! } : {}),
    }]
  })
  if (options.length === 0) return null
  const isThoughtLevel = legacyModesRepresentThoughtLevels(currentValue, options)
  const category = isThoughtLevel ? "thought_level" : "mode"
  return {
    id: category,
    name: isThoughtLevel ? "Thought Level" : "Mode",
    category,
    type: "select",
    currentValue,
    options,
    source: "mode",
  }
}

const LEGACY_THOUGHT_LEVEL_MODE_IDS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"])

function legacyModesRepresentThoughtLevels(currentValue: string, options: AgentConfigOption["options"]): boolean {
  if (options.length < 2) return false
  const values = options.map((option) => option.value.toLowerCase())
  if (LEGACY_THOUGHT_LEVEL_MODE_IDS.has(currentValue.toLowerCase()) && values.every((value) => LEGACY_THOUGHT_LEVEL_MODE_IDS.has(value))) {
    return true
  }
  return options.every((option) => {
    const text = `${option.value} ${option.name} ${option.description ?? ""}`.toLowerCase()
    return /\b(thinking|thought|reasoning)\b/.test(text)
  })
}

function contentBlockFromContent(content: unknown): AgentContentBlock | null {
  if (!isRecord(content)) return null
  const type = stringField(content, "type")
  if (!type || type === "text") return null
  return { ...content, type }
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

export function parseAcpCapabilities(value: unknown): AcpAgentCapabilities {
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

async function readTextFileForAcp(workdir: string, params: Record<string, unknown>): Promise<{ content: string }> {
  const requestedPath = stringField(params, "path")
  if (!requestedPath) throw new Error("fs/read_text_file requires path")
  const filePath = resolveAcpFsPath(workdir, requestedPath)
  const text = await Bun.file(filePath).text()
  const line = numberField(params, "line")
  const limit = numberField(params, "limit")
  if (!line && !limit) return { content: text }

  const lines = text.split(/\r?\n/)
  const start = Math.max(0, Math.floor((line ?? 1) - 1))
  const end = limit && limit > 0 ? start + Math.floor(limit) : undefined
  return { content: lines.slice(start, end).join("\n") }
}

async function writeTextFileForAcp(workdir: string, params: Record<string, unknown>): Promise<Record<string, never>> {
  const requestedPath = stringField(params, "path")
  const content = stringField(params, "content")
  if (!requestedPath) throw new Error("fs/write_text_file requires path")
  if (content === undefined) throw new Error("fs/write_text_file requires content")
  const filePath = resolveAcpFsPath(workdir, requestedPath)
  await mkdir(dirname(filePath), { recursive: true })
  await Bun.write(filePath, content)
  return {}
}

function resolveAcpFsPath(workdir: string, requestedPath: string): string {
  const root = resolve(workdir)
  const target = resolve(root, requestedPath)
  const rel = relative(root, target)
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target
  throw new Error("ACP filesystem request path is outside the session workdir")
}

function parsePromptUsage(value: unknown): AgentEvent | null {
  if (!isRecord(value) || !isRecord(value.usage)) return null
  const usage = value.usage
  const inputTokens = numberField(usage, "inputTokens") ?? numberField(usage, "input_tokens")
  const outputTokens = numberField(usage, "outputTokens") ?? numberField(usage, "output_tokens")
  if (!inputTokens && !outputTokens) return null
  return {
    kind: "usage",
    inputTokens,
    outputTokens,
    cumulative: true,
  }
}

export function isPermissionOption(value: unknown): value is PermissionOption {
  if (!isRecord(value)) return false
  const kind = value.kind
  return typeof value.optionId === "string"
    && typeof value.name === "string"
    && (kind === "allow_once" || kind === "allow_always" || kind === "reject_once" || kind === "reject_always")
}

function isAssistantTextStreamUpdate(update: Record<string, unknown>): boolean {
  return stringField(update, "sessionUpdate") === "agent_message_chunk"
}

function textFromContent(content: unknown): string | null {
  if (!isRecord(content)) return null
  return content.type === "text" && typeof content.text === "string" ? content.text : null
}

function stringifyToolContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts = content
    .filter(isRecord)
    .map((entry) => entry.type === "content" ? textFromContent(entry.content) : null)
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

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\u2026`
}

export function readStderr(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): void {
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
