// Claude Code agent provider: spawns `claude` CLI as a local process with stdin/stdout piping.
// No tunnel, no HTTP, no port allocation — just subprocess I/O.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import type { AgentFactory, AgentHandle, AgentEvent, AgentStartContext, PromptImage } from "./provider"
import { parseNdjsonStream, createClaudeCodeMapper } from "./ndjson"
import { AGENT_PROVIDER_METADATA } from "./metadata"

const log = createLogger("claude-code-provider")

export function createClaudeCodeProvider(): AgentFactory {
  return {
    metadata: AGENT_PROVIDER_METADATA["claude-code"],
    start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
      const taskLog = log.child({ taskId: ctx.taskId })

      return Effect.tryPromise({
        try: async () => {
          const spawnClaude = (sessionFlag: string) => {
            const args = [
              "claude",
              "--output-format", "stream-json",
              "--input-format", "stream-json",
              "--verbose",
              ...sessionFlag.split(" "),
              ...(ctx.model ? ["--model", ctx.model] : []),
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

            abort() {
              return Effect.try({
                try: () => {
                  // Send SIGINT to interrupt the current turn
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
                try {
                  proc.kill()
                } catch {
                  // process may already be dead
                }
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
