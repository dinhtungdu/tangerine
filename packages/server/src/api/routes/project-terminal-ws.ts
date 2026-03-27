// WebSocket route for interactive terminal access to a project's main repo.
// Creates a persistent tmux session named "{project}-repo" in the project's
// repo directory. The session is only initialized on first access — designed
// for emergency debugging when tasks can't run normally.

import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { spawn } from "bun-pty"
import type { IPty } from "bun-pty"
import type { AppDeps } from "../app"
import { createLogger } from "../../logger"

const log = createLogger("project-terminal-ws")

/** tmux session name for a project's repo terminal */
export function projectTmuxSessionName(projectName: string): string {
  return `${projectName}-repo`
}

/** Ensure a tmux session exists for the project repo, creating one if needed. */
async function ensureTmuxSession(sessionName: string, cwd: string): Promise<void> {
  const check = Bun.spawnSync(["tmux", "has-session", "-t", sessionName], {
    stderr: "pipe",
  })
  if (check.exitCode === 0) return

  const create = Bun.spawnSync([
    "tmux", "new-session", "-d", "-s", sessionName, "-c", cwd,
  ], { stderr: "pipe" })
  if (create.exitCode !== 0) {
    throw new Error(`Failed to create tmux session: ${create.stderr.toString()}`)
  }
}

export function projectTerminalWsRoutes(deps: AppDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono()

  app.get(
    "/:name/terminal",
    upgradeWebSocket((c) => {
      const projectName = c.req.param("name")!
      let pty: IPty | null = null
      let alive = true

      return {
        onOpen(_event, ws) {
          const project = deps.config.config.projects.find((p) => p.name === projectName)
          if (!project) {
            ws.send(JSON.stringify({ type: "error", message: `Project "${projectName}" not found` }))
            ws.close(1011, "Project not found")
            return
          }

          const workspace = deps.config.config.workspace
          const repoDir = `${workspace}/${projectName}/repo`
          const sessionName = projectTmuxSessionName(projectName)

          log.info("Project terminal session starting", { projectName, repoDir, sessionName })

          ensureTmuxSession(sessionName, repoDir)
            .then(() => {
              if (!alive) return

              pty = spawn("tmux", [
                "attach-session", "-t", sessionName,
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
            .catch((err) => {
              log.error("Project terminal session failed", { projectName, error: String(err) })
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
          log.debug("Project terminal detached (tmux session preserved)", { projectName })
        },
      }
    })
  )

  return app
}
