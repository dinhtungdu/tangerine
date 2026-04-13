// Codex agent provider: spawns `codex app-server` as a persistent subprocess
// and communicates via JSON-RPC 2.0 over stdin/stdout (NDJSON framing).
// Multi-turn conversations use the same process and thread — prompts are sent
// as `turn/start` requests on the same threadId.

import { Effect } from "effect"
import { PROVIDER_DISPLAY_NAMES } from "@tangerine/shared"
import { createLogger } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import type { AgentFactory, AgentHandle, AgentEvent, AgentStartContext, PromptImage, ModelInfo, ProviderMetadata } from "./provider"
import { parseNdjsonStream } from "./ndjson"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { scanCodexSkills } from "./skill-scanner"
import { join } from "node:path"
import { killDescendants, killProcessTreeEscalated } from "./process-tree"

const log = createLogger("codex-provider")
export const CODEX_APPROVAL_POLICY = "never" as const
export const CODEX_SANDBOX_MODE = "danger-full-access" as const
export const CODEX_SANDBOX_POLICY = { type: "dangerFullAccess" } as const
export const CODEX_PROVIDER_METADATA: ProviderMetadata = {
  displayName: PROVIDER_DISPLAY_NAMES.codex,
  abbreviation: "CX",
  cliCommand: "codex",
  reasoningEfforts: [
    { value: "none", label: "None", description: "No reasoning" },
    { value: "minimal", label: "Minimal", description: "Brief reasoning" },
    { value: "low", label: "Low", description: "Quick, minimal thinking" },
    { value: "medium", label: "Medium", description: "Balanced (default)" },
    { value: "high", label: "High", description: "Extended reasoning" },
    { value: "xhigh", label: "Extra High", description: "Maximum reasoning depth" },
  ],
  skills: {
    directory: join(homedir(), ".codex", "skills"),
  },
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 helpers
// ---------------------------------------------------------------------------

let rpcIdCounter = 0

function rpcRequest(method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id: ++rpcIdCounter, method, params }) + "\n"
}

function rpcNotification(method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n"
}

// ---------------------------------------------------------------------------
// App-server notification → AgentEvent mapping
//
// Protocol reference: codex app-server JSON-RPC 2.0 (codex-rs/app-server)
//
// Server notifications:
//   turn/started              { threadId, turn }
//   turn/completed            { threadId, turn }
//   item/started              { threadId, turnId, item }
//   item/completed            { threadId, turnId, item }
//   item/agentMessage/delta   { threadId, turnId, itemId, delta }
//   item/reasoning/summaryTextDelta  { threadId, turnId, itemId, delta }
//   item/commandExecution/outputDelta  { threadId, turnId, itemId, ... }
//   error                     { message }
//   thread/started            { thread }
//   thread/status/changed     { threadId, status }
//
// Server requests (approval callbacks — auto-approved):
//   item/commandExecution/requestApproval  { threadId, turnId, itemId, command }
//   item/fileChange/requestApproval        { ... }
//   item/permissions/requestApproval       { ... }
//
// Item types (in item/started, item/completed):
//   agentMessage       { text, phase: "final_answer"|... }
//   reasoning          { summary, content }
//   commandExecution   { command, aggregated_output, exit_code, status }
//   fileChange         { changes: [{ path, kind }], status }
//   mcpToolCall        { server, tool, arguments, result, error, status }
//   webSearch          { id, query, action }
//   todoList           { items: [{ text, completed }] }
//   error              { message }
//   userMessage        (ignored)
// ---------------------------------------------------------------------------

function mapNotification(method: string, params: Record<string, unknown>): AgentEvent[] {
  switch (method) {
    case "turn/started":
      return [{ kind: "status", status: "working" }]

    case "turn/completed": {
      const events: AgentEvent[] = [{ kind: "status", status: "idle" }]
      // Extract token usage from turn object if available
      const turn = params.turn as Record<string, unknown> | undefined
      const usage = (turn?.usage ?? turn?.tokenUsage) as Record<string, unknown> | undefined
      if (usage) {
        const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens
          : typeof usage.input_tokens === "number" ? usage.input_tokens : 0
        const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens
          : typeof usage.output_tokens === "number" ? usage.output_tokens : 0
        if (inputTokens > 0 || outputTokens > 0) {
          events.push({ kind: "usage", inputTokens, outputTokens })
        }
      }
      return events
    }

    case "item/started":
    case "item/completed": {
      const item = params.item as Record<string, unknown> | undefined
      if (!item) return []
      return method === "item/started" ? mapItemStart(item) : mapItemComplete(item)
    }

    case "item/agentMessage/delta": {
      const delta = params.delta as string | undefined
      if (typeof delta === "string") {
        return [{ kind: "message.streaming", content: delta }]
      }
      return []
    }

    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const delta = params.delta as string | undefined
      if (typeof delta === "string") {
        return [{ kind: "thinking", content: delta }]
      }
      return []
    }

    case "error": {
      const msg = typeof params.message === "string" ? params.message : "Codex error"
      return [{ kind: "error", message: msg }]
    }

    default:
      return []
  }
}

function mapItemStart(item: Record<string, unknown>): AgentEvent[] {
  switch (item.type) {
    case "commandExecution":
      if (typeof item.command === "string") {
        return [{ kind: "tool.start", toolName: "shell", toolInput: truncate(item.command, 500) }]
      }
      return []

    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const paths = changes
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
        .map((c) => `${c.kind ?? "update"}: ${c.path ?? "?"}`)
      return [{ kind: "tool.start", toolName: "file_change", toolInput: paths.join(", ") || undefined }]
    }

    case "mcpToolCall":
      return [{
        kind: "tool.start",
        toolName: `mcp:${item.server ?? "?"}/${item.tool ?? "?"}`,
        toolInput: item.arguments ? truncate(JSON.stringify(item.arguments), 500) : undefined,
      }]

    case "webSearch":
      return [{
        kind: "tool.start",
        toolName: "web_search",
        toolInput: typeof item.query === "string" ? item.query : undefined,
      }]

    default:
      return []
  }
}

function mapItemComplete(item: Record<string, unknown>): AgentEvent[] {
  switch (item.type) {
    case "agentMessage": {
      if (typeof item.text !== "string" || !item.text) return []
      // The app-server gives us a `phase` field — "final_answer" is the assistant result,
      // everything else is intermediate narration.
      const role = item.phase === "final_answer" ? "assistant" as const : "narration" as const
      return [{
        kind: "message.complete",
        role,
        content: item.text,
        messageId: typeof item.id === "string" ? item.id : undefined,
      }]
    }

    case "reasoning":
      // Full reasoning summary on completion
      if (Array.isArray(item.summary)) {
        const text = item.summary
          .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
          .map((s) => typeof s.text === "string" ? s.text : "")
          .join("")
        if (text) return [{ kind: "thinking", content: truncate(text, 300) }]
      }
      return []

    case "commandExecution": {
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : ""
      const status = item.status as string | undefined
      const result = status === "failed" || status === "declined"
        ? `[${status}] ${output}`
        : output
      return [{ kind: "tool.end", toolName: "shell", toolResult: truncate(result, 500) }]
    }

    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const paths = changes
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
        .map((c) => `${c.kind ?? "update"}: ${c.path ?? "?"}`)
      return [{ kind: "tool.end", toolName: "file_change", toolResult: paths.join(", ") || undefined }]
    }

    case "mcpToolCall": {
      const toolName = `mcp:${item.server ?? "?"}/${item.tool ?? "?"}`
      const error = item.error as Record<string, unknown> | undefined
      if (error && typeof error.message === "string") {
        return [{ kind: "tool.end", toolName, toolResult: `[error] ${truncate(error.message, 400)}` }]
      }
      const result = item.result as Record<string, unknown> | undefined
      const content = result?.content
      return [{ kind: "tool.end", toolName, toolResult: content ? truncate(JSON.stringify(content), 500) : undefined }]
    }

    case "webSearch":
      return [{ kind: "tool.end", toolName: "web_search" }]

    case "error":
      if (typeof item.message === "string") {
        return [{ kind: "error", message: item.message }]
      }
      return []

    default:
      return []
  }
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + "\u2026"
}

function isDangerFullAccessPolicy(value: unknown): boolean {
  // thread/start and thread/resume may echo back the string mode or the object form
  if (value === CODEX_SANDBOX_MODE) return true
  return typeof value === "object"
    && value !== null
    && (value as Record<string, unknown>).type === CODEX_SANDBOX_POLICY.type
}

function logThreadConfig(
  taskLog: ReturnType<typeof log.child>,
  phase: "started" | "resumed",
  threadId: string,
  result: Record<string, unknown>,
): void {
  const approvalPolicy = result.approvalPolicy
  const sandbox = result.sandbox
  taskLog.info(`Codex thread ${phase}`, {
    threadId,
    approvalPolicy,
    sandbox,
    cwd: result.cwd,
    model: result.model,
  })

  if (approvalPolicy !== CODEX_APPROVAL_POLICY || !isDangerFullAccessPolicy(sandbox)) {
    taskLog.warn("Codex thread execution policy differs from Tangerine default", {
      threadId,
      expectedApprovalPolicy: CODEX_APPROVAL_POLICY,
      actualApprovalPolicy: approvalPolicy,
      expectedSandbox: CODEX_SANDBOX_POLICY.type,
      actualSandbox: sandbox,
    })
  }
}

export function buildCodexThreadStartParams(
  ctx: Pick<AgentStartContext, "workdir" | "model" | "systemPrompt">,
): Record<string, unknown> {
  return {
    cwd: ctx.workdir,
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.systemPrompt ? { developerInstructions: ctx.systemPrompt } : {}),
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandbox: CODEX_SANDBOX_MODE,
    ephemeral: false,
  }
}

export function buildCodexThreadResumeParams(
  ctx: Pick<AgentStartContext, "workdir" | "model" | "systemPrompt"> & { threadId: string },
): Record<string, unknown> {
  return {
    threadId: ctx.threadId,
    cwd: ctx.workdir,
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.systemPrompt ? { developerInstructions: ctx.systemPrompt } : {}),
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandbox: CODEX_SANDBOX_MODE,
    persistExtendedHistory: false,
  }
}

export function buildCodexTurnStartParams(
  ctx: Pick<AgentStartContext, "workdir" | "model"> & {
    threadId: string
    input: Array<Record<string, unknown>>
    effort?: string
  },
): Record<string, unknown> {
  return {
    threadId: ctx.threadId,
    input: ctx.input,
    cwd: ctx.workdir,
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.effort ? { effort: ctx.effort } : {}),
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandboxPolicy: CODEX_SANDBOX_POLICY,
  }
}

// ---------------------------------------------------------------------------
// Model discovery — reads Codex's local models cache
// ---------------------------------------------------------------------------

const CODEX_MODELS_CACHE = join(homedir(), ".codex", "models_cache.json")

/**
 * Discover available Codex models by reading ~/.codex/models_cache.json.
 * Only includes models with visibility "list" (publicly available).
 */
export function discoverModels(): ModelInfo[] {
  if (!existsSync(CODEX_MODELS_CACHE)) return []
  try {
    const raw = JSON.parse(readFileSync(CODEX_MODELS_CACHE, "utf-8")) as {
      models?: Array<{ slug: string; display_name?: string; visibility?: string; supported_in_api?: boolean }>
    }
    if (!Array.isArray(raw.models)) return []
    return raw.models
      .filter((m) => m.visibility === "list")
      .map((m) => ({
        id: m.slug,
        name: m.display_name ?? m.slug,
        provider: "openai",
        providerName: "OpenAI",
      }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createCodexProvider(): AgentFactory {
  return {
    metadata: CODEX_PROVIDER_METADATA,
    listModels() {
      return discoverModels()
    },
    start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
      const taskLog = log.child({ taskId: ctx.taskId })

      return Effect.tryPromise({
        try: async () => {
          const subscribers = new Set<(e: AgentEvent) => void>()
          let shutdownCalled = false
          let threadId: string | null = null
          let activeTurnId: string | null = null
          const activeEffort: string | undefined = ctx.reasoningEffort
          let activeSystemPrompt = ctx.systemPrompt

          const emit = (event: AgentEvent) => {
            for (const cb of subscribers) cb(event)
          }

          // Spawn persistent app-server process
          const proc = Bun.spawn(["codex", "app-server"], {
            cwd: ctx.workdir,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, ...ctx.env },
          })

          taskLog.info("Codex app-server spawned", { pid: proc.pid })

          const write = (data: string) => {
            proc.stdin.write(data)
            proc.stdin.flush()
          }

          // Track pending RPC responses for the handshake
          const pendingRpc = new Map<number, {
            resolve: (result: Record<string, unknown>) => void
            reject: (err: Error) => void
          }>()

          // Parse NDJSON from stdout — handles both RPC responses and notifications
          const parser = parseNdjsonStream(
            proc.stdout as ReadableStream<Uint8Array>,
            {
              onLine: (data) => {
                const msg = data as Record<string, unknown>
                const hasId = "id" in msg && msg.id !== null
                const method = msg.method as string | undefined

                // JSON-RPC 2.0 message types:
                // - Response (from server answering our request): has `id`, has `result`/`error`, NO `method`
                // - Server request (approval callbacks): has `id` AND `method`
                // - Server notification: has `method`, NO `id`

                // Server request — approval callbacks that need a response
                if (hasId && method) {
                  if (method.endsWith("/requestApproval")) {
                    write(JSON.stringify({
                      jsonrpc: "2.0",
                      id: msg.id,
                      result: { decision: "approved" },
                    }) + "\n")
                  }
                  // Other server requests we don't handle — ignore
                  return
                }

                // RPC response to one of our requests
                if (hasId && !method) {
                  const id = msg.id as number
                  const pending = pendingRpc.get(id)
                  if (pending) {
                    pendingRpc.delete(id)
                    if (msg.error) {
                      const err = msg.error as Record<string, unknown>
                      pending.reject(new Error(typeof err.message === "string" ? err.message : JSON.stringify(err)))
                    } else {
                      pending.resolve((msg.result ?? {}) as Record<string, unknown>)
                    }
                  }
                  return
                }

                // Server notification
                if (!method) return
                const params = (msg.params ?? {}) as Record<string, unknown>

                // Track active turn ID for abort
                if (method === "turn/started") {
                  const turn = params.turn as Record<string, unknown> | undefined
                  if (typeof turn?.id === "string") activeTurnId = turn.id
                }
                if (method === "turn/completed" || method === "turn/failed") {
                  activeTurnId = null
                }

                const events = mapNotification(method, params)
                for (const event of events) {
                  emit(event)
                }
              },
              onError: (err) => {
                if (!shutdownCalled) {
                  taskLog.error("stdout parse error", { error: err.message })
                  emit({ kind: "error", message: err.message })
                }
              },
              onEnd: () => {
                if (!shutdownCalled) {
                  taskLog.info("Codex app-server stdout ended")
                  emit({ kind: "status", status: "idle" })
                }
              },
            },
          )

          // Log stderr in background
          ;(async () => {
            try {
              const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
              const decoder = new TextDecoder()
              while (true) {
                const { done, value } = await stderrReader.read()
                if (done) break
                const text = decoder.decode(value, { stream: true }).trim()
                if (text) taskLog.debug("codex stderr", { text })
              }
            } catch {
              // stderr may close abruptly
            }
          })()

          // Helper to send RPC request and wait for response (with timeout)
          const RPC_TIMEOUT_MS = 30_000
          const rpcCall = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
            return new Promise((resolve, reject) => {
              const req = rpcRequest(method, params)
              const id = rpcIdCounter
              const timer = setTimeout(() => {
                pendingRpc.delete(id)
                reject(new Error(`RPC call "${method}" timed out after ${RPC_TIMEOUT_MS}ms`))
              }, RPC_TIMEOUT_MS)
              pendingRpc.set(id, {
                resolve: (result) => { clearTimeout(timer); resolve(result) },
                reject: (err) => { clearTimeout(timer); reject(err) },
              })
              write(req)
            })
          }

          // --- Handshake: initialize → initialized → thread/start ---

          // Step 1: initialize
          const initResult = await rpcCall("initialize", {
            clientInfo: { name: "tangerine", title: "Tangerine", version: "1.0.0" },
            capabilities: {},
          })
          taskLog.info("Codex initialized", { userAgent: initResult.userAgent })

          // Step 2: initialized notification
          write(rpcNotification("initialized"))

          const ensureThread = async () => {
            if (threadId) return threadId
            if (ctx.resumeSessionId) {
              try {
                const resumeResult = await rpcCall("thread/resume", buildCodexThreadResumeParams({
                  threadId: ctx.resumeSessionId,
                  workdir: ctx.workdir,
                  model: ctx.model,
                  systemPrompt: activeSystemPrompt,
                }))
                const thread = resumeResult.thread as Record<string, unknown> | undefined
                threadId = typeof thread?.id === "string" ? thread.id : ctx.resumeSessionId
                logThreadConfig(taskLog, "resumed", threadId, resumeResult)
                return threadId
              } catch (err) {
                taskLog.warn("Thread resume failed, starting fresh", { error: String(err) })
              }
            }

            const threadResult = await rpcCall("thread/start", buildCodexThreadStartParams({
              workdir: ctx.workdir,
              model: ctx.model,
              systemPrompt: activeSystemPrompt,
            }))
            const thread = threadResult.thread as Record<string, unknown> | undefined
            threadId = typeof thread?.id === "string" ? thread.id : null
            if (threadId) {
              logThreadConfig(taskLog, "started", threadId, threadResult)
              return threadId
            }
            throw new Error("Failed to obtain Codex thread ID")
          }

          await ensureThread()

          // Ready for prompts
          emit({ kind: "status", status: "idle" })

          const handle: AgentHandle = {
            sendPrompt(text: string, images?: PromptImage[]) {
              return Effect.tryPromise({
                try: async () => {
                  if (shutdownCalled) return
                  const ensuredThreadId = await ensureThread()

                  // Build input content array (Codex uses OpenAI Responses API format)
                  const input: Array<Record<string, unknown>> = []
                  if (images && images.length > 0) {
                    for (const img of images) {
                      input.push({
                        type: "image",
                        url: `data:${img.mediaType};base64,${img.data}`,
                      })
                    }
                  }
                  if (text) {
                    input.push({ type: "text", text, text_elements: [] })
                  }

                  // Send turn/start — response is immediate, events stream as notifications
                  write(rpcRequest("turn/start", buildCodexTurnStartParams({
                    threadId: ensuredThreadId,
                    workdir: ctx.workdir,
                    model: ctx.model,
                    input,
                    effort: activeEffort,
                  })))
                },
                catch: (e) =>
                  new PromptError({ message: `Failed to send turn: ${e}`, taskId: ctx.taskId }),
              })
            },

            setSystemPrompt(text: string) {
              return Effect.sync(() => {
                if (threadId) return false
                activeSystemPrompt = text
                return true
              })
            },

            abort() {
              return Effect.try({
                try: () => {
                  // Kill child processes (e.g. bash commands) but keep the
                  // Codex app-server alive so the session can accept follow-ups.
                  killDescendants(proc.pid, "SIGTERM")
                  if (threadId && activeTurnId) {
                    write(rpcRequest("turn/interrupt", { threadId, turnId: activeTurnId }))
                  }
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
                shutdownCalled = true
                parser.stop()
                subscribers.clear()
                pendingRpc.clear()
                try {
                  proc.stdin.end()
                } catch {
                  // stdin may already be closed
                }
                killProcessTreeEscalated(proc.pid)
                taskLog.info("Codex app-server shutdown")
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
              return scanCodexSkills()
            },
          }

          // Attach metadata — sessionId is the threadId
          Object.defineProperty(handle, "__meta", {
            get: () => ({
              sessionId: threadId,
              agentPort: null as number | null,
            }),
          })
          ;(handle as { __pid?: number }).__pid = proc.pid
          ;(handle as { __taskId?: string }).__taskId = ctx.taskId

          return handle
        },
        catch: (e) =>
          new SessionStartError({
            message: `Codex app-server start failed: ${e}`,
            taskId: ctx.taskId,
            phase: "start-codex",
            cause: e instanceof Error ? e : new Error(String(e)),
          }),
      })
    },
  }
}
