// REST routes for TUI mode toggle: start/stop TUI, get status.

import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { getTask } from "../../db/queries"
import { startTuiMode, stopTuiMode, isTuiActive } from "../../tasks/tui"
import { getTaskState } from "../../tasks/task-state"

export function tuiRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  // POST /api/tasks/:id/tui — start TUI mode
  app.post("/:id/tui", async (c) => {
    const taskId = c.req.param("id")!

    const task = await Effect.runPromise(getTask(deps.db, taskId).pipe(Effect.catchAll(() => Effect.succeed(null))))
    if (!task) return c.json({ error: "Task not found" }, 404)
    if (task.status !== "running") return c.json({ error: "Task is not running" }, 400)

    const tuiConfig = deps.getTuiCommand?.(task.provider)
    if (!tuiConfig) return c.json({ error: "TUI not supported for this agent" }, 400)

    if (isTuiActive(taskId)) return c.json({ error: "TUI already active" }, 400)

    try {
      await Effect.runPromise(
        startTuiMode(taskId, tuiConfig.command, {
          resumeTemplate: tuiConfig.resumeTemplate,
          getAgentHandle: deps.getAgentHandle,
          removeAgentHandle: deps.removeAgentHandle!,
          getTask: (id) => getTask(deps.db, id),
          logActivity: deps.logActivity!,
          onTuiExit: deps.onTuiExit,
        })
      )
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }

    return c.json({ ok: true, mode: "tui" })
  })

  // POST /api/tasks/:id/tui/stop — stop TUI mode, reconnect ACP
  app.post("/:id/tui/stop", async (c) => {
    const taskId = c.req.param("id")!

    if (!isTuiActive(taskId)) return c.json({ error: "TUI not active" }, 400)

    let sessionId: string
    try {
      const result = await Effect.runPromise(stopTuiMode(taskId))
      sessionId = result.sessionId
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }

    await Effect.runPromise(
      deps.logActivity!(taskId, "lifecycle", "tui.stopped", "Switched to Chat mode").pipe(
        Effect.catchAll(() => Effect.succeed(undefined))
      )
    )

    deps.reconnectAfterTui?.(taskId, sessionId)

    return c.json({ ok: true, mode: "chat" })
  })

  // GET /api/tasks/:id/tui/status
  app.get("/:id/tui/status", (c) => {
    const taskId = c.req.param("id")!
    const state = getTaskState(taskId)
    return c.json({ mode: state.tuiMode ? "tui" : "chat" })
  })

  return app
}
