import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { getTask, getSessionLogs } from "../../db/queries"
import { getActivities } from "../../activity"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { normalizeTimestamps } from "../helpers"
import { TaskNotFoundError } from "../../errors"
import { getProjectConfig, getRepoDir, TANGERINE_HOME } from "../../config"
import { getTaskState } from "../../tasks/task-state"

function gitDiff(cmd: string, cwd: string): Effect.Effect<string, never> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" })
      return new Response(proc.stdout).text()
    },
    catch: () => new Error("git diff failed"),
  }).pipe(Effect.catchAll(() => Effect.succeed("")))
}

function parseDiffChunks(raw: string): { path: string; diff: string }[] {
  const files: { path: string; diff: string }[] = []
  const chunks = raw.split(/(?=^diff --git )/m).filter(Boolean)
  for (const chunk of chunks) {
    const match = chunk.match(/^diff --git a\/.+ b\/(.+)$/m)
    if (match) files.push({ path: match[1]!, diff: chunk })
  }
  return files
}

export function sessionRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.get("/:id/config-options", (c) => {
    return c.json({ configOptions: getTaskState(c.req.param("id")).configOptions })
  })

  app.get("/:id/messages", (c) => {
    return runEffect(c,
      getSessionLogs(deps.db, c.req.param("id")).pipe(
        Effect.map((rows) => rows.map(normalizeTimestamps))
      )
    )
  })

  app.get("/:id/images/:filename", async (c) => {
    const taskId = c.req.param("id")
    const filename = c.req.param("filename")
    // Prevent path traversal
    if (filename.includes("/") || filename.includes("..")) {
      return c.json({ error: "invalid filename" }, 400)
    }
    const filePath = `${TANGERINE_HOME}/images/${taskId}/${filename}`
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      return c.json({ error: "not found" }, 404)
    }
    return new Response(file, {
      headers: { "Content-Type": file.type, "Cache-Control": "public, max-age=31536000, immutable" },
    })
  })

  app.post("/:id/prompt", async (c) => {
    const body = await c.req.json<{ text?: string; fromTaskId?: string }>()
    if (!body.text) {
      return c.json({ error: "text is required" }, 400)
    }
    return runEffectVoid(c,
      deps.taskManager.sendPrompt(c.req.param("id"), body.text!, undefined, body.fromTaskId)
    )
  })

  // REST chat endpoint: sends a prompt and persists the user message.
  // Async — returns immediately. Use GET /messages or WebSocket for agent response.
  app.post("/:id/chat", async (c) => {
    const taskId = c.req.param("id")
    const body = await c.req.json<{ text?: string; fromTaskId?: string }>()
    if (!body.text) {
      return c.json({ error: "text is required" }, 400)
    }
    return runEffect(c,
      Effect.gen(function* () {
        const task = yield* getTask(deps.db, taskId)
        if (!task) return yield* Effect.fail(new TaskNotFoundError({ taskId }))

        // Send to agent (sendPrompt persists the user message to session_logs)
        yield* deps.taskManager.sendPrompt(taskId, body.text!, undefined, body.fromTaskId)

        return { ok: true, taskId, status: task.status }
      }),
      { status: 202 }
    )
  })

  app.post("/:id/abort", (c) => {
    return runEffectVoid(c,
      deps.taskManager.abortTask(c.req.param("id"))
    )
  })

  app.post("/:id/model", async (c) => {
    const taskId = c.req.param("id")
    const body = await c.req.json<{ model?: string; reasoningEffort?: string; mode?: string }>()
    if (!body.model && !body.reasoningEffort && !body.mode) {
      return c.json({ error: "model, reasoningEffort, or mode is required" }, 400)
    }
    return runEffectVoid(c,
      deps.taskManager.changeConfig(taskId, { model: body.model, reasoningEffort: body.reasoningEffort, mode: body.mode })
    )
  })

  // Returns git diff of all changes on the task branch vs origin/{defaultBranch}.
  // Priority: worktree (live, includes uncommitted) > branch ref (post-cleanup).
  app.get("/:id/diff", (c) => {
    return runEffect(c,
      Effect.gen(function* () {
        const task = yield* getTask(deps.db, c.req.param("id"))
        if (!task) return yield* Effect.fail(new TaskNotFoundError({ taskId: c.req.param("id") }))

        const project = getProjectConfig(deps.config.config, task.project_id)
        const defaultBranch = project?.defaultBranch ?? "main"

        let raw = ""

        if (task.worktree_path) {
          raw = yield* gitDiff(`git diff origin/${defaultBranch}...HEAD`, task.worktree_path)
        } else if (task.branch) {
          const repoDir = getRepoDir(deps.config.config, task.project_id)
          raw = yield* gitDiff(`git diff origin/${defaultBranch}...${task.branch}`, repoDir)
        }

        if (!raw) return { files: [] }

        return { files: parseDiffChunks(raw) }
      })
    )
  })

  app.get("/:id/activities", (c) => {
    return runEffect(c,
      getActivities(deps.db, c.req.param("id")).pipe(
        Effect.map((rows) => rows.map(normalizeTimestamps))
      )
    )
  })

  app.get("/:id/skills", (c) => {
    const handle = deps.getAgentHandle(c.req.param("id"))
    const skills = handle?.getSkills?.() ?? []
    return c.json({ skills: [...new Set(skills)] })
  })

  return app
}
