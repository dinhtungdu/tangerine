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
 * Event types from codex-rs/exec/src/exec_events.rs (ThreadEvent enum):
 *
 * Thread-level:
 *   thread.started   { thread_id }
 *
 * Turn-level:
 *   turn.started     {}
 *   turn.completed   { usage: { input_tokens, cached_input_tokens, output_tokens } }
 *   turn.failed      { error: { message } }
 *
 * Item-level (item.started | item.updated | item.completed):
 *   Item types (ThreadItemDetails, tagged by item.type, snake_case):
 *     agent_message      { text }
 *     reasoning          { text }
 *     command_execution  { command, aggregated_output, exit_code, status: in_progress|completed|failed|declined }
 *     file_change        { changes: [{ path, kind: add|delete|update }], status }
 *     mcp_tool_call      { server, tool, arguments, result, error, status }
 *     web_search         { id, query, action }
 *     todo_list          { items: [{ text, completed }] }
 *     error              { message }
 *
 * Top-level:
 *   error             { message }
 *
 * Note: agent_message items are NOT mapped here — they are handled by the
 * streaming layer which buffers them for narration/assistant role decision.
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
      return mapItemStart(item)
    }

    case "item.updated": {
      // Incremental update to an in-progress item — treat like a start for
      // items we haven't seen yet, or ignore for already-tracked ones.
      // The main value is streaming reasoning text.
      const item = raw.item as Record<string, unknown> | undefined
      if (!item) return []

      if (item.type === "reasoning" && typeof item.text === "string") {
        return [{ kind: "thinking", content: truncate(item.text, 300) }]
      }
      return []
    }

    case "item.completed": {
      const item = raw.item as Record<string, unknown> | undefined
      if (!item) return []
      return mapItemComplete(item)
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

function mapItemStart(item: Record<string, unknown>): AgentEvent[] {
  switch (item.type) {
    case "command_execution":
      if (typeof item.command === "string") {
        return [{ kind: "tool.start", toolName: "shell", toolInput: truncate(item.command, 500) }]
      }
      return []

    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const paths = changes
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
        .map((c) => `${c.kind ?? "update"}: ${c.path ?? "?"}`)
      return [{ kind: "tool.start", toolName: "file_change", toolInput: paths.join(", ") || undefined }]
    }

    case "mcp_tool_call":
      return [{
        kind: "tool.start",
        toolName: `mcp:${item.server ?? "?"}/${item.tool ?? "?"}`,
        toolInput: item.arguments ? truncate(JSON.stringify(item.arguments), 500) : undefined,
      }]

    case "web_search":
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
    // agent_message handled in streaming layer, not here

    case "reasoning":
      if (typeof item.text === "string") {
        return [{ kind: "thinking", content: truncate(item.text, 300) }]
      }
      return []

    case "command_execution": {
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : ""
      const status = item.status as string | undefined
      const result = status === "failed" || status === "declined"
        ? `[${status}] ${output}`
        : output
      return [{ kind: "tool.end", toolName: "shell", toolResult: truncate(result, 500) }]
    }

    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const paths = changes
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
        .map((c) => `${c.kind ?? "update"}: ${c.path ?? "?"}`)
      return [{ kind: "tool.end", toolName: "file_change", toolResult: paths.join(", ") || undefined }]
    }

    case "mcp_tool_call": {
      const toolName = `mcp:${item.server ?? "?"}/${item.tool ?? "?"}`
      const error = item.error as Record<string, unknown> | undefined
      if (error && typeof error.message === "string") {
        return [{ kind: "tool.end", toolName, toolResult: `[error] ${truncate(error.message, 400)}` }]
      }
      const result = item.result as Record<string, unknown> | undefined
      const content = result?.content
      return [{ kind: "tool.end", toolName, toolResult: content ? truncate(JSON.stringify(content), 500) : undefined }]
    }

    case "web_search":
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

            // Buffer the latest agent_message: we don't know if a message is
            // the final answer or intermediate narration until the next event
            // arrives.  When a new message comes in, flush the previous one as
            // narration.  When the turn completes, emit the buffered message as
            // the assistant result instead.
            let pendingMessage: { text: string; id?: string } | null = null

            const flushPendingAsNarration = () => {
              if (pendingMessage) {
                emit({
                  kind: "message.complete",
                  role: "narration",
                  content: pendingMessage.text,
                  messageId: pendingMessage.id,
                })
                pendingMessage = null
              }
            }

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

                  // Buffer agent_message items — skip mapCodexEvent for these
                  // since we handle narration/assistant role ourselves.
                  const item = raw.item as Record<string, unknown> | undefined
                  if (raw.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
                    // A new message arrived — flush the previous one as narration
                    flushPendingAsNarration()
                    pendingMessage = {
                      text: item.text,
                      id: typeof item.id === "string" ? item.id : undefined,
                    }
                    return
                  }

                  const events = mapCodexEvent(raw)
                  for (const event of events) {
                    // When turn completes, emit the buffered message as assistant
                    if (event.kind === "status" && event.status === "idle" && pendingMessage) {
                      emit({
                        kind: "message.complete",
                        role: "assistant",
                        content: pendingMessage.text,
                        messageId: pendingMessage.id,
                      })
                      pendingMessage = null
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
                    // Flush any buffered message as assistant if stream ended
                    // without a turn.completed event
                    if (pendingMessage) {
                      emit({
                        kind: "message.complete",
                        role: "assistant",
                        content: pendingMessage.text,
                        messageId: pendingMessage.id,
                      })
                      pendingMessage = null
                    }
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
