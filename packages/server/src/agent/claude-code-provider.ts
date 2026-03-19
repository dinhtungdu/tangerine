// Claude Code agent provider: spawns `claude` CLI inside VM via SSH with stdin/stdout piping.
// No tunnel, no HTTP, no port allocation — just subprocess I/O.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { AgentError, PromptError, SessionStartError } from "../errors"
import { VM_USER } from "../config"
import type { AgentFactory, AgentHandle, AgentEvent, AgentStartContext } from "./provider"
import { parseNdjsonStream, mapClaudeCodeEvent } from "./ndjson"

const log = createLogger("claude-code-provider")

export function createClaudeCodeProvider(): AgentFactory {
  return {
    start(ctx: AgentStartContext): Effect.Effect<AgentHandle, SessionStartError> {
      const taskLog = log.child({ taskId: ctx.taskId })

      return Effect.tryPromise({
        try: async () => {
          const sessionId = crypto.randomUUID()

          // Spawn SSH with interactive stdin/stdout piped to `claude`
          const proc = Bun.spawn(
            [
              "ssh",
              "-T",
              "-o", "StrictHostKeyChecking=no",
              "-o", "UserKnownHostsFile=/dev/null",
              "-o", "LogLevel=ERROR",
              "-p", String(ctx.sshPort),
              `${VM_USER}@${ctx.vmIp}`,
              [
                // Source env vars (API keys, OAuth tokens) injected by lifecycle
                `test -f ~/.env && set -a && . ~/.env && set +a;`,
                `cd ${ctx.workdir} &&`,
                `claude`,
                `--output-format stream-json`,
                `--input-format stream-json`,
                `--verbose`,
                `--session-id ${sessionId}`,
                `--dangerously-skip-permissions`,
              ].join(" "),
            ],
            {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            },
          )

          taskLog.info("Claude Code spawned", { sessionId })

          const subscribers = new Set<(e: AgentEvent) => void>()
          let shutdownCalled = false

          // Parse NDJSON from stdout
          const parser = parseNdjsonStream(
            proc.stdout as ReadableStream<Uint8Array>,
            {
              onLine: (data) => {
                const event = mapClaudeCodeEvent(data as Record<string, unknown>)
                if (event) {
                  for (const cb of subscribers) cb(event)
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
            sendPrompt(text: string) {
              return Effect.try({
                try: () => {
                  const msg = JSON.stringify({
                    type: "user",
                    message: { role: "user", content: text },
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
                  // Send SIGINT to the SSH process, which forwards to claude
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
          }

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
