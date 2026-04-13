// Pi agent provider: spawns `pi` CLI in RPC mode as a persistent subprocess
// and communicates via NDJSON over stdin/stdout.
// Multi-turn conversations use the same process — prompts are sent as
// `prompt` commands on the same session.

import { Effect } from "effect"
import { PROVIDER_DISPLAY_NAMES } from "@tangerine/shared"
import { createLogger } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import type { AgentFactory, AgentHandle, AgentEvent, AgentStartContext, AgentConfig, PromptImage, ModelInfo, ProviderMetadata } from "./provider"
import { parseNdjsonStream } from "./ndjson"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { scanSkillsDir } from "./skill-scanner"
import { killDescendants, killProcessTreeEscalated } from "./process-tree"

const log = createLogger("pi-provider")
export const PI_PROVIDER_METADATA: ProviderMetadata = {
  displayName: PROVIDER_DISPLAY_NAMES.pi,
  abbreviation: "Pi",
  cliCommand: "pi",
  reasoningEfforts: [
    { value: "off", label: "Off", description: "No thinking" },
    { value: "minimal", label: "Minimal", description: "Brief reasoning" },
    { value: "low", label: "Low", description: "Quick, minimal thinking" },
    { value: "medium", label: "Medium", description: "Balanced (default)" },
    { value: "high", label: "High", description: "Extended reasoning" },
    { value: "xhigh", label: "Extra High", description: "Maximum reasoning depth" },
  ],
  skills: {
    directory: join(homedir(), ".pi", "agent", "skills"),
  },
}

// ---------------------------------------------------------------------------
// Pi RPC event → AgentEvent mapping
//
// Pi's RPC mode emits AgentSessionEvent objects (from @mariozechner/pi-agent-core)
// as NDJSON on stdout. Responses to commands have `type: "response"`.
//
// Core events:
//   agent_start              → status working
//   agent_end                → status idle
//   turn_start               → (ignored, agent_start covers it)
//   turn_end                 → (ignored, agent_end covers it)
//   message_start            → (ignored, wait for streaming)
//   message_update           → message.streaming (text delta) or thinking
//   message_end              → message.complete
//   tool_execution_start     → tool.start
//   tool_execution_update    → (ignored)
//   tool_execution_end       → tool.end
//   compaction_start/end     → (ignored)
//   auto_retry_start/end     → (ignored)
//   queue_update             → (ignored)
// ---------------------------------------------------------------------------

/** Creates a per-session event mapper with its own thinking buffer. */
export function createPiEventMapper(): (data: Record<string, unknown>) => AgentEvent[] {
  // Accumulates thinking deltas across thinking_start/thinking_end boundaries.
  // Pi streams thinking as individual token deltas — without buffering, each
  // delta would be persisted as a separate session_log row and chat message.
  let thinkingBuffer = ""

  return (data: Record<string, unknown>): AgentEvent[] => {
    const type = data.type as string | undefined
    if (!type) return []

    switch (type) {
      case "agent_start":
        return [{ kind: "status", status: "working" }]

      case "agent_end":
        // Usage is emitted per-turn from turn_end — don't also sum
        // agent_end.messages or the last event will double-count.
        return [{ kind: "status", status: "idle" }]

      case "turn_end": {
        // turn_end.message is a single AgentMessage
        const msg = data.message as Record<string, unknown> | undefined
        if (!msg) return []
        const usage = extractPiMessageUsage(msg)
        return usage ? [usage] : []
      }

      case "message_update": {
        // data.assistantMessageEvent contains the streaming delta
        // AME types: text_start, text_delta, text_end, thinking_start, thinking_delta, thinking_end,
        //            toolcall_start, toolcall_delta, toolcall_end, start, done, error
        const ame = data.assistantMessageEvent as Record<string, unknown> | undefined
        if (!ame) return []

        const ameType = ame.type as string | undefined

        // Thinking/reasoning — buffer deltas, emit on end
        if (ameType === "thinking_start") {
          thinkingBuffer = ""
          return []
        }
        if (ameType === "thinking_delta") {
          const delta = typeof ame.delta === "string" ? ame.delta : ""
          thinkingBuffer += delta
          return []
        }
        if (ameType === "thinking_end") {
          const content = thinkingBuffer
          thinkingBuffer = ""
          if (content) return [{ kind: "thinking", content: truncate(content, 300) }]
          return []
        }

        // Text content delta
        if (ameType === "text_delta") {
          const delta = typeof ame.delta === "string" ? ame.delta : ""
          if (delta) return [{ kind: "message.streaming", content: delta }]
          return []
        }

        return []
      }

      case "message_end": {
        const msg = data.message as Record<string, unknown> | undefined
        if (!msg) return []
        const role = msg.role
        if (role !== "assistant" && role !== "user") return []
        // Extract text from the message content
        const content = msg.content as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(content)) return []
        const textParts = content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
        const text = textParts.join("")
        if (!text) return []
        if (role === "user") {
          return [{ kind: "message.complete", role: "user" as const, content: text }]
        }
        // Assistant messages with tool calls are intermediate turns — classify
        // as narration so the UI collapses them alongside thinking.
        const hasToolCalls = content.some((c) => c.type === "toolCall")
        return [{ kind: "message.complete", role: hasToolCalls ? "narration" as const : "assistant" as const, content: text }]
      }

      case "tool_execution_start": {
        const toolName = typeof data.toolName === "string" ? data.toolName : "unknown"
        const args = data.args
        return [{
          kind: "tool.start",
          toolName,
          toolInput: args ? truncate(JSON.stringify(args), 500) : undefined,
        }]
      }

      case "tool_execution_end": {
        const toolName = typeof data.toolName === "string" ? data.toolName : "unknown"
        const result = data.result as Record<string, unknown> | undefined
        const isError = data.isError === true
        let toolResult: string | undefined
        if (result) {
          const content = result.content as Array<Record<string, unknown>> | undefined
          if (Array.isArray(content)) {
            const texts = content
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text as string)
            toolResult = texts.join("")
          }
        }
        if (isError && toolResult) {
          toolResult = `[error] ${toolResult}`
        }
        return [{
          kind: "tool.end",
          toolName,
          toolResult: toolResult ? truncate(toolResult, 500) : undefined,
        }]
      }

      default:
        return []
    }
  }
}

// Pi's Usage type: { input, output, cacheRead, cacheWrite, totalTokens, cost }
// Lives on AssistantMessage.usage (not at event top level).
export function extractPiMessageUsage(msg: Record<string, unknown>): { kind: "usage"; inputTokens: number; outputTokens: number } | null {
  const usage = msg.usage as Record<string, unknown> | undefined
  if (!usage) return null
  const input = typeof usage.input === "number" ? usage.input : 0
  const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0
  const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0
  const inputTokens = input + cacheRead + cacheWrite
  const outputTokens = typeof usage.output === "number" ? usage.output : 0
  if (inputTokens === 0 && outputTokens === 0) return null
  return { kind: "usage", inputTokens, outputTokens }
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + "\u2026"
}

export function buildPiPromptCommand(text: string, images?: PromptImage[]): Record<string, unknown> {
  const cmd: Record<string, unknown> = { type: "prompt", message: text }
  if (images && images.length > 0) {
    cmd.images = images.map((img) => ({
      type: "image",
      mimeType: img.mediaType,
      data: img.data,
    }))
  }
  return cmd
}

export function buildPiSystemPromptCommand(text: string): Record<string, unknown> {
  return { type: "set_system_prompt", prompt: text }
}

// ---------------------------------------------------------------------------
// Model discovery — runs `pi --list-models` and parses the table output
// ---------------------------------------------------------------------------

/**
 * Discover available Pi models by running `pi --list-models`.
 */
export function discoverModels(): ModelInfo[] {
  try {
    const result = spawnSync("pi", ["--list-models"], {
      timeout: 5_000,
      encoding: "utf-8",
      env: { ...process.env, PI_OFFLINE: "1" },
    })
    // Pi writes model list to stderr; prefer it over stdout
    const output = (result.stderr || result.stdout || "").trim()
    if (result.status !== 0 || !output) return []
    const lines = output.split("\n")
    // Skip the header line
    const models = lines.slice(1)
      .map((line) => {
        const cols = line.trim().split(/\s{2,}/)
        const provider = cols[0]
        const modelId = cols[1]
        if (!provider || !modelId) return null
        const id = `${provider}/${modelId}`
        return {
          id,
          name: modelId,
          provider,
          providerName: provider.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
        }
      })
      .filter((m): m is ModelInfo => m !== null)
    return models
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createPiProvider(): AgentFactory {
  return {
    metadata: PI_PROVIDER_METADATA,
    listModels() {
      return discoverModels()
    },
    start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
      const taskLog = log.child({ taskId: ctx.taskId })

      return Effect.tryPromise({
        try: async () => {
          const subscribers = new Set<(e: AgentEvent) => void>()
          let shutdownCalled = false
          let sessionId: string | null = null
          // Track the current model's provider for set_model commands
          let currentModelProvider: string | null = null
          // Skills discovered from get_state response
          let discoveredSkills: string[] = []

          let latestUsage: { inputTokens: number; outputTokens: number } | null = null

          const emit = (event: AgentEvent) => {
            if (event.kind === "usage") {
              latestUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
            }
            for (const cb of subscribers) cb(event)
          }

          // Build CLI args for RPC mode
          const args = [
            "pi",
            "--mode", "rpc",
            "--no-extensions",
            "--no-prompt-templates",
            "--no-themes",
            ...(ctx.model ? ["--model", ctx.model] : []),
            ...(ctx.systemPrompt ? ["--append-system-prompt", ctx.systemPrompt] : []),
            ...(ctx.reasoningEffort ? ["--thinking", ctx.reasoningEffort] : []),
          ]

          // Resume previous session if available
          if (ctx.resumeSessionId) {
            args.push("--session", ctx.resumeSessionId)
          }

          const proc = Bun.spawn(args, {
            cwd: ctx.workdir,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, ...ctx.env },
          })

          taskLog.info("Pi spawned in RPC mode", { pid: proc.pid, isResume: !!ctx.resumeSessionId })

          // If resuming, verify the process stays alive
          if (ctx.resumeSessionId) {
            const exitedEarly = await Promise.race([
              proc.exited.then(() => true),
              new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
            ])
            if (exitedEarly) {
              taskLog.warn("Resume failed — session file may not exist", {
                resumeSessionId: ctx.resumeSessionId,
                exitCode: proc.exitCode,
              })
              // Can't respawn easily in RPC mode, let the error propagate
              throw new Error(`Pi session resume failed (exit code ${proc.exitCode})`)
            }
          }

          const write = (data: string) => {
            proc.stdin.write(data)
            proc.stdin.flush()
          }

          // Send an RPC command as NDJSON
          const sendCommand = (cmd: Record<string, unknown>) => {
            write(JSON.stringify(cmd) + "\n")
          }

          // Promise that resolves once the initial get_state response arrives
          let resolveReady: (() => void) | null = null
          const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve })

          // Per-session event mapper (owns its own thinking buffer)
          const mapPiEvent = createPiEventMapper()

          // Parse NDJSON from stdout
          const parser = parseNdjsonStream(
            proc.stdout as ReadableStream<Uint8Array>,
            {
              onLine: (data) => {
                const msg = data as Record<string, unknown>
                const msgType = msg.type as string | undefined

                // Capture session state from get_state response
                if (msgType === "response" && msg.command === "get_state" && msg.success === true) {
                  const stateData = msg.data as Record<string, unknown> | undefined
                  if (stateData) {
                    if (typeof stateData.sessionId === "string") {
                      sessionId = stateData.sessionId
                      taskLog.info("Pi session resolved", { sessionId })
                    }
                    // Track model provider for set_model commands
                    const model = stateData.model as Record<string, unknown> | undefined
                    if (model && typeof model.provider === "string") {
                      currentModelProvider = model.provider
                    }
                    // Capture available skills from state
                    if (Array.isArray(stateData.skills)) {
                      discoveredSkills = stateData.skills.filter((s): s is string => typeof s === "string")
                    }
                  }
                  emit({ kind: "status", status: "idle" })
                  if (resolveReady) {
                    resolveReady()
                    resolveReady = null
                  }
                  return
                }

                // Track provider changes from set_model responses
                if (msgType === "response" && msg.command === "set_model" && msg.success === true) {
                  const modelData = msg.data as Record<string, unknown> | undefined
                  if (modelData && typeof modelData.provider === "string") {
                    currentModelProvider = modelData.provider
                  }
                  return
                }

                // Skip other response messages (they're acknowledgements)
                if (msgType === "response") return

                // Skip extension UI requests
                if (msgType === "extension_ui_request") return

                const events = mapPiEvent(msg)
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
                  taskLog.info("Pi stdout ended")
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
                if (text) taskLog.debug("pi stderr", { text })
              }
            } catch {
              // stderr may close abruptly
            }
          })()

          // Request initial state and wait for session ID before returning handle
          sendCommand({ type: "get_state" })
          await Promise.race([
            readyPromise,
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("Pi get_state timed out after 15s")), 15_000),
            ),
          ])

          const handle: AgentHandle = {
            sendPrompt(text: string, images?: PromptImage[]) {
              return Effect.try({
                try: () => {
                  if (shutdownCalled) return
                  sendCommand(buildPiPromptCommand(text, images))
                },
                catch: (e) =>
                  new PromptError({ message: `Failed to send prompt: ${e}`, taskId: ctx.taskId }),
              })
            },

            setSystemPrompt(text: string) {
              return Effect.try({
                try: () => {
                  if (shutdownCalled) return false
                  sendCommand(buildPiSystemPromptCommand(text))
                  return true
                },
                catch: (e) =>
                  new AgentError({ message: `Failed to set system prompt: ${e}`, taskId: ctx.taskId }),
              })
            },

            abort() {
              return Effect.try({
                try: () => {
                  // Kill child processes (e.g. bash commands) but keep the
                  // Pi session alive so it can accept follow-up prompts.
                  killDescendants(proc.pid, "SIGTERM")
                  sendCommand({ type: "abort" })
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
                try {
                  proc.stdin.end()
                } catch {
                  // stdin may already be closed
                }
                killProcessTreeEscalated(proc.pid)
                taskLog.info("Pi shutdown")
              })
            },

            updateConfig(config: AgentConfig) {
              return Effect.try({
                try: () => {
                  if (shutdownCalled) return false
                  if (config.model) {
                    // Pi set_model expects provider and modelId separately.
                    // Model IDs may come as "provider/modelId" or bare "modelId".
                    const slashIdx = config.model.indexOf("/")
                    if (slashIdx >= 1) {
                      sendCommand({ type: "set_model", provider: config.model.slice(0, slashIdx), modelId: config.model.slice(slashIdx + 1) })
                    } else {
                      // Bare model ID — use the current session's provider
                      const provider = currentModelProvider ?? "unknown"
                      sendCommand({ type: "set_model", provider, modelId: config.model })
                    }
                  }
                  if (config.reasoningEffort) {
                    sendCommand({ type: "set_thinking_level", level: config.reasoningEffort })
                  }
                  return true
                },
                catch: (e) =>
                  new AgentError({ message: `Config update failed: ${e}`, taskId: ctx.taskId }),
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

            getUsage() {
              return latestUsage
            },

            getSkills() {
              // Pi reports skills via get_state; fall back to filesystem scan if
              // the response didn't include a skills field.
              if (discoveredSkills.length > 0) return discoveredSkills
              return scanSkillsDir(PI_PROVIDER_METADATA.skills.directory)
            },
          }

          // Attach metadata
          Object.defineProperty(handle, "__meta", {
            get: () => ({
              sessionId,
              agentPort: null as number | null,
            }),
          })
          ;(handle as { __pid?: number }).__pid = proc.pid
          ;(handle as { __taskId?: string }).__taskId = ctx.taskId

          return handle
        },
        catch: (e) =>
          new SessionStartError({
            message: `Pi start failed: ${e}`,
            taskId: ctx.taskId,
            phase: "start-pi",
            cause: e instanceof Error ? e : new Error(String(e)),
          }),
      })
    },
  }
}
