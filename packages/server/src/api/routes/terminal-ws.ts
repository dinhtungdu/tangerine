// WebSocket route for interactive terminal access to a task's VM worktree.
// Uses bun-pty for proper PTY allocation so resize works correctly.
// Spawns SSH with tmux for session persistence across reconnects.

import { Effect } from "effect"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { spawn } from "bun-pty"
import type { IPty } from "bun-pty"
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
      let pty: IPty | null = null
      let alive = true

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
              const remoteCmd = `cd ${worktree} && tmux new-session -A -s ${sessionName}`

              log.info("Terminal session starting", { taskId, vm: vm.ip, worktree })

              pty = spawn("ssh", [
                "-tt",
                "-o", "StrictHostKeyChecking=no",
                "-o", "ServerAliveInterval=15",
                "-p", String(vm.ssh_port),
                `${VM_USER}@${vm.ip}`,
                remoteCmd,
              ], {
                cols: 80,
                rows: 24,
                name: "xterm-256color",
              })

              pty.onData((data) => {
                if (!alive) return
                try {
                  ws.send(JSON.stringify({ type: "output", data }))
                } catch {
                  // Client disconnected
                }
              })

              pty.onExit(({ exitCode }) => {
                if (!alive) return
                try {
                  ws.send(JSON.stringify({ type: "exit", code: exitCode }))
                } catch {
                  // Client gone
                }
              })

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
          if (!pty) return

          let parsed: { type: string; data?: string; cols?: number; rows?: number }
          try {
            const raw = typeof event.data === "string" ? event.data : event.data.toString()
            parsed = JSON.parse(raw)
          } catch {
            return
          }

          if (parsed.type === "input" && parsed.data) {
            pty.write(parsed.data)
          } else if (parsed.type === "resize" && parsed.cols && parsed.rows) {
            pty.resize(parsed.cols, parsed.rows)
          }
        },

        onClose() {
          alive = false
          if (pty) {
            try {
              pty.kill()
            } catch {
              // Already dead
            }
            pty = null
          }
          log.debug("Terminal session closed", { taskId })
        },
      }
    })
  )

  return app
}
