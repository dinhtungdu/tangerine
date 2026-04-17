// Claude Code agent provider: spawns `claude` CLI as a local process with stdin/stdout piping.
// No tunnel, no HTTP, no port allocation — just subprocess I/O.

import { Effect } from "effect"
import { PROVIDER_DISPLAY_NAMES } from "@tangerine/shared"
import { createLogger } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import type { AgentFactory, AgentHandle, AgentEvent, AgentStartContext, PromptImage, ProviderMetadata, ModelInfo } from "./provider"
import { parseNdjsonStream, createClaudeCodeMapper } from "./ndjson"
import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { killDescendants, killProcessTreeEscalated } from "./process-tree"
import { readCredentialsFile } from "../config"

const log = createLogger("claude-code-provider")

// ---------------------------------------------------------------------------
// Model discovery — tries Anthropic REST API, falls back to static list
// ---------------------------------------------------------------------------

// Models known to Claude Code. IDs match the first-party Anthropic API IDs from
// the Claude Code source (configs.ts). Opus/Sonnet 4.6 use unversioned canonical
// IDs; older models require the dated suffix. Context windows default to 200K.
// Keep ordered newest→oldest so the model picker shows the best options first.
const CLAUDE_CODE_KNOWN_MODELS = [
  { id: "claude-opus-4-7",           name: "Claude Opus 4.7",     provider: "anthropic", providerName: "Anthropic", contextWindow: 1_000_000 },
  { id: "claude-opus-4-6",           name: "Claude Opus 4.6",     provider: "anthropic", providerName: "Anthropic", contextWindow: 1_000_000 },
  { id: "claude-opus-4-5-20251101",  name: "Claude Opus 4.5",     provider: "anthropic", providerName: "Anthropic", contextWindow: 200_000 },
  { id: "claude-sonnet-4-6",         name: "Claude Sonnet 4.6",   provider: "anthropic", providerName: "Anthropic", contextWindow: 200_000 },
  { id: "claude-sonnet-4-5-20250929",name: "Claude Sonnet 4.5",   provider: "anthropic", providerName: "Anthropic", contextWindow: 200_000 },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5",    provider: "anthropic", providerName: "Anthropic", contextWindow: 200_000 },
  { id: "claude-3-7-sonnet-20250219",name: "Claude 3.7 Sonnet",   provider: "anthropic", providerName: "Anthropic", contextWindow: 200_000 },
  { id: "claude-3-5-sonnet-20241022",name: "Claude 3.5 Sonnet",   provider: "anthropic", providerName: "Anthropic", contextWindow: 200_000 },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku",    provider: "anthropic", providerName: "Anthropic", contextWindow: 200_000 },
]

// Canonical model ID patterns, ordered most-specific first.
// Used to map versioned API IDs (e.g. "claude-opus-4-6-20250514") to our short IDs.
const CANONICAL_PATTERNS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-opus-4",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-haiku-4-5",
  "claude-3-7-sonnet",
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
  "claude-3-opus",
] as const

/** Strip date/provider suffixes from an API model ID to get the canonical short ID. */
export function toCanonicalId(apiId: string): string {
  const lower = apiId.toLowerCase()
  for (const pattern of CANONICAL_PATTERNS) {
    if (lower.includes(pattern)) return pattern
  }
  return apiId
}

const CLAUDE_MODELS_CACHE = join(homedir(), ".claude", "tangerine-models-cache.json")
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000 // 24 h

/** Fetch model list from the Anthropic REST API using ANTHROPIC_API_KEY.
 * Checks process.env first, then the Tangerine credentials dotfile, so
 * keys set via `tangerine config set ANTHROPIC_API_KEY=...` are honoured. */
function fetchAnthropicModels(): Array<{ id: string; context_window?: number }> | null {
  try {
    // env var takes precedence; fall back to the Tangerine credentials dotfile so
    // keys set via `tangerine config set ANTHROPIC_API_KEY=...` are honoured.
    const apiKey = process.env.ANTHROPIC_API_KEY ?? readCredentialsFile().ANTHROPIC_API_KEY
    if (!apiKey) return null
    const result = spawnSync("curl", [
      "-sf", "--max-time", "5",
      "https://api.anthropic.com/v1/models",
      "-H", `x-api-key: ${apiKey}`,
      "-H", "anthropic-version: 2023-06-01",
    ], { encoding: "utf-8", timeout: 6_000 })
    if (result.status !== 0 || !result.stdout) return null
    const data = JSON.parse(result.stdout) as { data?: Array<{ id: string; context_window?: number }> }
    return data.data ?? null
  } catch {
    return null
  }
}

/**
 * Discover Claude models with per-model context windows from the Anthropic API.
 * Results are cached to disk for 24 h; falls back to static list if unavailable.
 */
export function discoverModels(): ModelInfo[] {
  let apiModels: Array<{ id: string; context_window?: number }> | null = null

  if (existsSync(CLAUDE_MODELS_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(CLAUDE_MODELS_CACHE, "utf-8")) as {
        fetchedAt: number
        models: Array<{ id: string; context_window?: number }>
      }
      if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        apiModels = cached.models
      }
    } catch { /* stale or corrupt cache, re-fetch below */ }
  }

  if (!apiModels) {
    apiModels = fetchAnthropicModels()
    if (apiModels) {
      try {
        writeFileSync(CLAUDE_MODELS_CACHE, JSON.stringify({ fetchedAt: Date.now(), models: apiModels }))
      } catch { /* non-fatal: cache write failure */ }
    }
  }

  // Use canonical IDs for dedup so versioned static IDs (e.g. "claude-haiku-4-5-20251001")
  // and unversioned API IDs (e.g. "claude-haiku-4-5") both map to the same key.
  const knownCanonicalIds = new Set(CLAUDE_CODE_KNOWN_MODELS.map((m) => toCanonicalId(m.id)))
  const contextMap = new Map(
    (apiModels ?? [])
      .filter((m): m is { id: string; context_window: number } =>
        typeof m.context_window === "number" && m.context_window > 0)
      .map((m) => [toCanonicalId(m.id), m.context_window]),
  )

  // Start with known models, enriched with API context windows when available
  const result: ModelInfo[] = CLAUDE_CODE_KNOWN_MODELS.map((m) => ({
    ...m,
    ...(contextMap.has(toCanonicalId(m.id)) ? { contextWindow: contextMap.get(toCanonicalId(m.id))! } : {}),
  }))

  // Add any Claude models from the API that aren't already in the static list.
  // Dedup by canonical ID but keep the original API ID for CLI compatibility.
  if (apiModels) {
    const seen = new Set<string>()
    for (const m of apiModels) {
      if (!m.id.startsWith("claude-")) continue
      const canonicalId = toCanonicalId(m.id)
      if (knownCanonicalIds.has(canonicalId) || seen.has(canonicalId)) continue
      seen.add(canonicalId)
      result.push({
        id: m.id,
        name: m.id,
        provider: "anthropic",
        providerName: "Anthropic",
        ...(typeof m.context_window === "number" && m.context_window > 0
          ? { contextWindow: m.context_window }
          : { contextWindow: 200_000 }),
      })
    }
  }

  return result
}

export const CLAUDE_CODE_PROVIDER_METADATA: ProviderMetadata = {
  displayName: PROVIDER_DISPLAY_NAMES["claude-code"],
  abbreviation: "CC",
  cliCommand: "claude",
  defaultModel: "claude-sonnet-4-6",
  defaultReasoningEffort: "medium",
  reasoningEfforts: [
    { value: "low", label: "Low", description: "Quick, minimal thinking" },
    { value: "medium", label: "Medium", description: "Balanced (default)" },
    { value: "high", label: "High", description: "Extended reasoning" },
    { value: "max", label: "Max", description: "Maximum reasoning depth" },
  ],
  skills: {
    directory: join(homedir(), ".claude", "skills"),
  },
}

export function createClaudeCodeProvider(): AgentFactory {
  return {
    metadata: CLAUDE_CODE_PROVIDER_METADATA,
    listModels() {
      return discoverModels()
    },
    start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
      const taskLog = log.child({ taskId: ctx.taskId })

      return Effect.tryPromise({
        try: async () => {
          const spawnClaude = (sessionFlag: string) => {
            const args = [
              "claude",
              "--output-format", "stream-json",
              "--input-format", "stream-json",
              "--include-partial-messages",
              "--verbose",
              ...sessionFlag.split(" "),
              ...(ctx.model ? ["--model", ctx.model] : []),
              ...(ctx.systemPrompt ? ["--append-system-prompt", ctx.systemPrompt] : []),
              ...(ctx.reasoningEffort ? ["--effort", ctx.reasoningEffort] : []),
              "--dangerously-skip-permissions",
              // Block interactive tools that expect user input — Tangerine can't
              // relay plan-mode or question prompts to the user.
              "--disallowedTools", "EnterPlanMode", "ExitPlanMode", "AskUserQuestion",
            ]
            return Bun.spawn(args, {
              cwd: ctx.workdir,
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
              env: { ...process.env, ...ctx.env },
            })
          }

          // Start with --resume if we have a previous session, else fresh
          let sessionId = ctx.resumeSessionId ?? crypto.randomUUID()
          const sessionFlag = ctx.resumeSessionId
            ? `--resume ${ctx.resumeSessionId}`
            : `--session-id ${sessionId}`

          let proc = spawnClaude(sessionFlag)
          taskLog.info("Claude Code spawned", { sessionId, isResume: !!ctx.resumeSessionId })

          // If resuming, verify the process stays alive. If it exits within
          // 3s it means the session file doesn't exist — fall back to fresh.
          if (ctx.resumeSessionId) {
            const exitedEarly = await Promise.race([
              proc.exited.then(() => true),
              new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000)),
            ])
            if (exitedEarly) {
              // Capture stderr to diagnose why resume failed
              let stderr = ""
              try {
                stderr = await new Response(proc.stderr as ReadableStream).text()
              } catch { /* stderr may be closed */ }
              taskLog.warn("Resume failed, falling back to fresh session", {
                resumeSessionId: ctx.resumeSessionId,
                exitCode: proc.exitCode,
                stderr: stderr.trim().slice(0, 200) || undefined,
              })
              sessionId = crypto.randomUUID()
              proc = spawnClaude(`--session-id ${sessionId}`)
              taskLog.info("Claude Code respawned fresh", { sessionId })
            }
          }

          const subscribers = new Set<(e: AgentEvent) => void>()
          let shutdownCalled = false
          // Capture the real session ID from Claude's init event (may differ from what we passed)
          let resolvedSessionId = sessionId
          // Skills discovered from system/init event
          let discoveredSkills: string[] = []
          let latestUsage: { inputTokens: number; outputTokens: number; contextTokens: number } | null = null
          // Stateful mapper — buffers images from tool results for next narration
          const mapClaudeCodeEvent = createClaudeCodeMapper()

          // Parse NDJSON from stdout
          const parser = parseNdjsonStream(
            proc.stdout as ReadableStream<Uint8Array>,
            {
              onLine: (data) => {
                const raw = data as Record<string, unknown>

                // Capture session_id and skills from system init event and signal ready
                if (raw.type === "system" && raw.subtype === "init" && typeof raw.session_id === "string") {
                  resolvedSessionId = raw.session_id
                  if (Array.isArray(raw.skills)) {
                    discoveredSkills = raw.skills.filter((s): s is string => typeof s === "string")
                  }
                  taskLog.info("Claude Code session resolved", { sessionId: resolvedSessionId, skillCount: discoveredSkills.length })
                  const idle: AgentEvent = { kind: "status", status: "idle" }
                  for (const cb of subscribers) cb(idle)
                }

                const events = mapClaudeCodeEvent(raw)
                for (const event of events) {
                  if (event.kind === "usage") {
                    latestUsage = {
                      inputTokens: event.inputTokens ?? latestUsage?.inputTokens ?? 0,
                      outputTokens: event.outputTokens ?? latestUsage?.outputTokens ?? 0,
                      contextTokens: event.contextTokens ?? latestUsage?.contextTokens ?? 0,
                    }
                    event.inputTokens = latestUsage.inputTokens
                    event.outputTokens = latestUsage.outputTokens
                    event.contextTokens = latestUsage.contextTokens
                  }
                  for (const cb of subscribers) cb(event)
                }
                // result event signals end of turn — emit idle after message.complete
                if (raw.type === "result" && !raw.is_error) {
                  const idle: AgentEvent = { kind: "status", status: "idle" }
                  for (const cb of subscribers) cb(idle)
                }
              },
              onError: (err) => {
                if (!shutdownCalled) {
                  taskLog.error("stdout parse error", { error: err.message })
                  const event: AgentEvent = { kind: "error", message: err.message }
                  for (const cb of subscribers) cb(event)
                }
              },
              onEnd: () => {
                if (!shutdownCalled) {
                  taskLog.info("Claude Code stdout ended")
                  const event: AgentEvent = { kind: "status", status: "idle" }
                  for (const cb of subscribers) cb(event)
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
                if (text) taskLog.debug("claude stderr", { text })
              }
            } catch {
              // stderr may close abruptly
            }
          })()

          const handle: AgentHandle = {
            sendPrompt(text: string, images?: PromptImage[]) {
              return Effect.try({
                try: () => {
                  // Build content as array when images are present, plain string otherwise
                  const content: unknown = images && images.length > 0
                    ? [
                        ...images.map((img) => ({
                          type: "image",
                          source: { type: "base64", media_type: img.mediaType, data: img.data },
                        })),
                        // Only include text block if non-empty — empty text blocks cause Claude API 400 errors
                        ...(text ? [{ type: "text", text }] : []),
                      ]
                    : text
                  const msg = JSON.stringify({
                    type: "user",
                    message: { role: "user", content },
                  }) + "\n"
                  proc.stdin.write(msg)
                  proc.stdin.flush()
                },
                catch: (e) =>
                  new PromptError({ message: `Failed to write to stdin: ${e}`, taskId: ctx.taskId }),
              })
            },

            setSystemPrompt() {
              return Effect.succeed(false)
            },

            abort() {
              return Effect.try({
                try: () => {
                  // Kill child processes (e.g. bash commands) but keep Claude
                  // Code alive — it handles SIGINT as "stop current tool".
                  killDescendants(proc.pid, "SIGTERM")
                  proc.kill("SIGINT")
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
                taskLog.info("Claude Code shutdown")
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
              return discoveredSkills
            },

            getUsage() {
              return latestUsage
            },
          }

          // Attach metadata — uses getter so resolvedSessionId updates after init event
          Object.defineProperty(handle, "__meta", {
            get: () => ({
              sessionId: resolvedSessionId,
              agentPort: null as number | null,
            }),
          })
          // Attach PID so getAgentPid() can save it to the task record
          ;(handle as { __pid?: number }).__pid = proc.pid
          // Attach taskId for cross-talk detection in subscriber callbacks
          ;(handle as { __taskId?: string }).__taskId = ctx.taskId

          return handle
        },
        catch: (e) =>
          new SessionStartError({
            message: `Claude Code start failed: ${e}`,
            taskId: ctx.taskId,
            phase: "start-claude-code",
            cause: e instanceof Error ? e : new Error(String(e)),
          }),
      })
    },
  }
}
