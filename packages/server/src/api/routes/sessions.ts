import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { getTask, getSessionLogs } from "../../db/queries"
import { getActivities } from "../../activity"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { normalizeTimestamps } from "../helpers"
import { TaskNotFoundError } from "../../errors"
import { getProjectConfig, TANGERINE_HOME } from "../../config"
import { createLogger } from "../../logger"

const log = createLogger("sessions")

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

/** Sync a review task's worktree to the latest commits on the parent's branch. */
function syncReviewWorktree(taskId: string, worktreePath: string, parentBranch: string): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(
        ["bash", "-c", `git fetch origin && git reset --hard origin/${parentBranch}`],
        { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
      )
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (exitCode !== 0) throw new Error(stderr)
      log.info("Review worktree synced to parent branch", { taskId, parentBranch })
    },
    catch: (e) => new Error(`review worktree sync failed: ${e}`),
  }).pipe(Effect.catchAll((e) => {
    log.warn("Failed to sync review worktree", { taskId, parentBranch, error: e.message })
    return Effect.void
  }))
}

export function sessionRoutes(deps: AppDeps): Hono {
  const app = new Hono()

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
    const body = await c.req.json<{ text?: string }>()
    if (!body.text) {
      return c.json({ error: "text is required" }, 400)
    }
    return runEffectVoid(c,
      Effect.gen(function* () {
        // For review tasks with a parent, sync the worktree to the parent's
        // latest commits before forwarding the prompt. This keeps the review
        // agent's code up to date across re-review cycles.
        const task = yield* getTask(deps.db, c.req.param("id"))
        if (task?.type === "review" && task.parent_task_id && task.worktree_path) {
          const parent = yield* getTask(deps.db, task.parent_task_id)
          if (parent?.branch) {
            yield* syncReviewWorktree(task.id, task.worktree_path, parent.branch)
          }
        }
        yield* deps.taskManager.sendPrompt(c.req.param("id"), body.text!)
      })
    )
  })

  // REST chat endpoint: sends a prompt and persists the user message.
  // Async — returns immediately. Use GET /messages or WebSocket for agent response.
  app.post("/:id/chat", async (c) => {
    const taskId = c.req.param("id")
    const body = await c.req.json<{ text?: string }>()
    if (!body.text) {
      return c.json({ error: "text is required" }, 400)
    }
    return runEffect(c,
      Effect.gen(function* () {
        const task = yield* getTask(deps.db, taskId)
        if (!task) return yield* Effect.fail(new TaskNotFoundError({ taskId }))

        // Send to agent (sendPrompt persists the user message to session_logs)
        yield* deps.taskManager.sendPrompt(taskId, body.text!)

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
    const body = await c.req.json<{ model?: string; reasoningEffort?: string }>()
    if (!body.model && !body.reasoningEffort) {
      return c.json({ error: "model or reasoningEffort is required" }, 400)
    }
    return runEffectVoid(c,
      deps.taskManager.changeConfig(c.req.param("id"), { model: body.model, reasoningEffort: body.reasoningEffort })
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
          const repoDir = `/workspace/${task.project_id}/repo`
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

  return app
}
