// WebSocket route for interactive terminal access to a task's VM worktree.
// Spawns SSH with tmux for session persistence across reconnects.

import { Effect } from "effect"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import type { AppDeps } from "../app"
import { getTask, getVm } from "../../db/queries"
import { VM_USER } from "../../config"
import { createLogger } from "../../logger"

const log = createLogger("terminal-ws")

export function terminalWsRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono()

  app.get(
    "/:id/terminal",
    upgradeWebSocket((c) => {
      const taskId = c.req.param("id")!
      let proc: ReturnType<typeof Bun.spawn> | null = null
      let alive = true
      let pendingSize: { cols: number; rows: number } | null = null
      let resizeTimer: ReturnType<typeof setTimeout> | null = null

      return {
        onOpen(_event, ws) {
          Effect.runPromise(
            Effect.gen(function* () {
              const task = yield* getTask(deps.db, taskId)
              if (!task?.vm_id) throw new Error("Task has no VM")

              const vm = yield* getVm(deps.db, task.vm_id)
              if (!vm?.ip || !vm.ssh_port) throw new Error("VM not available")

              const worktree = task.worktree_path ?? "/workspace/repo"
              const sessionName = `task-${taskId.slice(0, 12)}`

              // tmux new-session -A: attach if exists, create if not
              // Client sends resize immediately after connect to set proper size
              const remoteCmd = `cd ${worktree} && tmux new-session -A -s ${sessionName}`

              log.info("Terminal session starting", { taskId, vm: vm.ip, worktree })

              proc = Bun.spawn(
                [
                  "ssh", "-tt",
                  "-o", "StrictHostKeyChecking=no",
                  "-o", "ServerAliveInterval=15",
                  "-p", String(vm.ssh_port),
                  `${VM_USER}@${vm.ip}`,
                  remoteCmd,
                ],
                { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
              )

              // Stream stdout → WebSocket
              const stdout = proc.stdout as ReadableStream<Uint8Array>
              const reader = stdout.getReader()
              const readLoop = async () => {
                const decoder = new TextDecoder()
                try {
                  while (alive) {
                    const { done, value } = await reader.read()
                    if (done) break
                    try {
                      ws.send(JSON.stringify({ type: "output", data: decoder.decode(value) }))
                    } catch {
                      break
                    }
                  }
                } catch {
                  // Reader closed
                }
                if (alive) {
                  const exitCode = await proc!.exited
                  try {
                    ws.send(JSON.stringify({ type: "exit", code: exitCode }))
                  } catch {
                    // Client gone
                  }
                }
              }
              readLoop()

              // Stream stderr → WebSocket (merged with stdout display)
              const stderr = proc.stderr as ReadableStream<Uint8Array>
              const errReader = stderr.getReader()
              const errLoop = async () => {
                const decoder = new TextDecoder()
                try {
                  while (alive) {
                    const { done, value } = await errReader.read()
                    if (done) break
                    try {
                      ws.send(JSON.stringify({ type: "output", data: decoder.decode(value) }))
                    } catch {
                      break
                    }
                  }
                } catch {
                  // Reader closed
                }
              }
              errLoop()

              ws.send(JSON.stringify({ type: "connected" }))
            })
          ).catch((err) => {
            log.error("Terminal session failed", { taskId, error: String(err) })
            try {
              ws.send(JSON.stringify({ type: "error", message: String(err) }))
              ws.close(1011, "Terminal setup failed")
            } catch {
              // Client already gone
            }
          })
        },

        onMessage(event) {
          if (!proc) return

          let parsed: { type: string; data?: string; cols?: number; rows?: number }
          try {
            const raw = typeof event.data === "string" ? event.data : event.data.toString()
            parsed = JSON.parse(raw)
          } catch {
            return
          }

          if (parsed.type === "input" && parsed.data) {
            const stdin = proc.stdin as import("bun").FileSink
            stdin.write(parsed.data)
          } else if (parsed.type === "resize" && parsed.cols && parsed.rows) {
            pendingSize = { cols: parsed.cols, rows: parsed.rows }

            // Debounce resize — only fire after 150ms of no resize events
            if (resizeTimer) clearTimeout(resizeTimer)
            resizeTimer = setTimeout(() => {
              if (!proc || !alive) return
              const sessionName = `task-${taskId.slice(0, 12)}`
              Effect.runPromise(
                Effect.gen(function* () {
                  const task = yield* getTask(deps.db, taskId)
                  if (!task?.vm_id) return
                  const vm = yield* getVm(deps.db, task.vm_id)
                  if (!vm?.ip || !vm.ssh_port) return

                  // Resize tmux window + all panes, then force refresh
                  const { cols, rows } = pendingSize!
                  const resizeCmd = `tmux set-option -t ${sessionName} force-width ${cols} \\; set-option -t ${sessionName} force-height ${rows} \\; resize-window -t ${sessionName} -x ${cols} -y ${rows} 2>/dev/null || true`
                  yield* deps.sshExec(vm.ip, vm.ssh_port, resizeCmd).pipe(Effect.catchAll(() => Effect.void))
                })
              ).catch(() => { /* resize is best-effort */ })
            }, 150)
          }
        },

        onClose() {
          alive = false
          if (resizeTimer) clearTimeout(resizeTimer)
          if (proc) {
            try {
              proc.kill()
            } catch {
              // Already dead
            }
            proc = null
          }
          log.debug("Terminal session closed", { taskId })
        },
      }
    })
  )

  return app
}
