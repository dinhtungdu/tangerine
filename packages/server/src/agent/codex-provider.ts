// Codex agent provider: spawns `codex exec` CLI per turn with JSONL streaming output.
// Each prompt runs a separate codex exec process; follow-up prompts use `codex exec resume`
// to maintain conversation context across turns.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import type { AgentFactory, AgentHandle, AgentEvent, AgentStartContext, PromptImage } from "./provider"
import { parseNdjsonStream } from "./ndjson"
import { tmpdir } from "os"
import { join } from "path"
import { writeFileSync, mkdirSync, unlinkSync } from "fs"

const log = createLogger("codex-provider")

/**
 * Maps a raw Codex JSONL event to normalized AgentEvents.
 *
 * Codex exec --json event types:
 * - thread.started: { thread_id } — session init
 * - turn.started: agent begins working
 * - item.started: { item: { type: "command_execution", command, status: "in_progress" } } — tool start
 * - item.completed: { item: { type: "agent_message", text } } — message
 * - item.completed: { item: { type: "command_execution", command, aggregated_output, exit_code } } — tool end
 * - turn.completed: { usage } — turn done
 * - turn.failed: { error } — error
 * - error: { message } — error
 */
function mapCodexEvent(raw: Record<string, unknown>): AgentEvent[] {
  const type = raw.type as string | undefined
  if (!type) return []

  switch (type) {
    case "turn.started": {
      return [{ kind: "status", status: "working" }]
    }

    case "item.started": {
      const item = raw.item as Record<string, unknown> | undefined
      if (!item) return []

      if (item.type === "command_execution" && typeof item.command === "string") {
        return [{
          kind: "tool.start",
          toolName: "shell",
          toolInput: truncate(item.command, 500),
        }]
      }
      return []
    }

    case "item.completed": {
      const item = raw.item as Record<string, unknown> | undefined
      if (!item) return []

      if (item.type === "agent_message" && typeof item.text === "string") {
        return [{
          kind: "message.complete",
          role: "narration",
          content: item.text,
          messageId: typeof item.id === "string" ? item.id : undefined,
        }]
      }

      if (item.type === "command_execution" && typeof item.command === "string") {
        const output = typeof item.aggregated_output === "string" ? item.aggregated_output : ""
        return [{
          kind: "tool.end",
          toolName: "shell",
          toolResult: truncate(output, 500),
        }]
      }

      // File-related items (file_create, file_edit, etc.)
      if (typeof item.type === "string" && typeof item.id === "string") {
        const itemType = item.type as string
        if (itemType.startsWith("file_")) {
          return [{
            kind: "tool.end",
            toolName: itemType,
            toolResult: typeof item.path === "string" ? item.path as string : undefined,
          }]
        }
      }

      return []
    }

    case "turn.completed": {
      return [{ kind: "status", status: "idle" }]
    }

    case "turn.failed": {
      const error = raw.error as Record<string, unknown> | undefined
      const message = typeof error?.message === "string" ? error.message : "Codex turn failed"
      return [
        { kind: "error", message },
        { kind: "status", status: "idle" },
      ]
    }

    case "error": {
      const message = typeof raw.message === "string" ? raw.message : "Codex error"
      return [{ kind: "error", message }]
    }

    default:
      return []
  }
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + "\u2026"
}

export function createCodexProvider(): AgentFactory {
  return {
    start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
      const taskLog = log.child({ taskId: ctx.taskId })

      return Effect.tryPromise({
        try: async () => {
          const subscribers = new Set<(e: AgentEvent) => void>()
          let shutdownCalled = false
          let threadId: string | null = ctx.resumeSessionId ?? null
          let currentProc: ReturnType<typeof Bun.spawn> | null = null
          let currentParser: { stop(): void } | null = null
          // Track the latest process PID for health checks
          let latestPid: number | null = null

          const emit = (event: AgentEvent) => {
            for (const cb of subscribers) cb(event)
          }

          /**
           * Spawn a codex exec process for a single turn.
           * First turn uses `codex exec`, follow-ups use `codex exec resume <threadId>`.
           */
          const runTurn = (prompt: string, images?: PromptImage[]) => {
            if (shutdownCalled) return

            // Write images to temp files if present
            const imagePaths: string[] = []
            if (images && images.length > 0) {
              const imgDir = join(tmpdir(), `codex-images-${ctx.taskId}`)
              mkdirSync(imgDir, { recursive: true })
              for (let i = 0; i < images.length; i++) {
                const ext = images[i]!.mediaType.split("/")[1] ?? "png"
                const path = join(imgDir, `img-${i}.${ext}`)
                writeFileSync(path, Buffer.from(images[i]!.data, "base64"))
                imagePaths.push(path)
              }
            }

            const imageArgs = imagePaths.flatMap((p) => ["-i", p])

            let args: string[]
            if (threadId) {
              // Resume existing session
              args = [
                "codex", "exec", "resume", threadId,
                "--json",
                "--dangerously-bypass-approvals-and-sandbox",
                "-C", ctx.workdir,
                ...(ctx.model ? ["-m", ctx.model] : []),
                ...imageArgs,
                prompt,
              ]
            } else {
              // Fresh session
              args = [
                "codex", "exec",
                "--json",
                "--dangerously-bypass-approvals-and-sandbox",
                "-C", ctx.workdir,
                ...(ctx.model ? ["-m", ctx.model] : []),
                ...imageArgs,
                prompt,
              ]
            }

            const proc = Bun.spawn(args, {
              cwd: ctx.workdir,
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
              env: { ...process.env, ...ctx.env },
            })

            currentProc = proc
            latestPid = proc.pid
            taskLog.info("Codex exec spawned", { threadId, isResume: !!threadId, pid: proc.pid })

            emit({ kind: "status", status: "working" })

            // Accumulate the last agent_message text for the final assistant message
            let lastMessageText = ""

            currentParser = parseNdjsonStream(
              proc.stdout as ReadableStream<Uint8Array>,
              {
                onLine: (data) => {
                  const raw = data as Record<string, unknown>

                  // Capture thread_id from thread.started event
                  if (raw.type === "thread.started" && typeof raw.thread_id === "string") {
                    threadId = raw.thread_id
                    taskLog.info("Codex thread started", { threadId })
                  }

                  // Track last message text for final result
                  const item = raw.item as Record<string, unknown> | undefined
                  if (raw.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
                    lastMessageText = item.text
                  }

                  const events = mapCodexEvent(raw)
                  for (const event of events) {
                    // When turn completes, emit the last message as assistant role
                    if (event.kind === "status" && event.status === "idle" && lastMessageText) {
                      emit({
                        kind: "message.complete",
                        role: "assistant",
                        content: lastMessageText,
                      })
                      lastMessageText = ""
                    }
                    emit(event)
                  }
                },
                onError: (err) => {
                  if (!shutdownCalled) {
                    taskLog.error("Codex stdout parse error", { error: err.message })
                    emit({ kind: "error", message: err.message })
                  }
                },
                onEnd: () => {
                  if (!shutdownCalled) {
                    taskLog.info("Codex process stdout ended")
                    // If process ended without a turn.completed, emit idle
                    emit({ kind: "status", status: "idle" })
                  }
                  // Clean up temp image files
                  for (const p of imagePaths) {
                    try { unlinkSync(p) } catch { /* ignore */ }
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
          }

          // Emit initial idle status (ready for first prompt)
          emit({ kind: "status", status: "idle" })

          const handle: AgentHandle = {
            sendPrompt(text: string, images?: PromptImage[]) {
              return Effect.try({
                try: () => {
                  runTurn(text, images)
                },
                catch: (e) =>
                  new PromptError({ message: `Codex exec failed: ${e}`, taskId: ctx.taskId }),
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
                try {
                  currentProc?.kill()
                } catch {
                  // process may already be dead
                }
                taskLog.info("Codex provider shutdown")
              })
            },

            isAlive() {
              if (!latestPid) return true // no process spawned yet, handle is valid
              try {
                process.kill(latestPid, 0)
                return true
              } catch {
                return false
              }
            },
          }

          // Attach metadata
          Object.defineProperty(handle, "__meta", {
            get: () => ({
              sessionId: threadId,
              agentPort: null as number | null,
            }),
          })
          // No persistent PID initially — updated when a turn starts
          Object.defineProperty(handle, "__pid", {
            get: () => latestPid,
          })

          taskLog.info("Codex provider initialized", { resumeThreadId: ctx.resumeSessionId })
          return handle
        },
        catch: (e) =>
          new SessionStartError({
            message: `Codex provider start failed: ${e}`,
            taskId: ctx.taskId,
            phase: "start-codex",
            cause: e instanceof Error ? e : new Error(String(e)),
          }),
      })
    },
  }
}
