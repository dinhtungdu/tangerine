import { Effect } from "effect"
import { Hono } from "hono"
import type { AppDeps } from "../app"
import { getTask, getSessionLogs, getSessionLogsPaginated } from "../../db/queries"
import { getActivities } from "../../activity"
import { runEffect, runEffectVoid } from "../effect-helpers"
import { normalizeTimestamps } from "../helpers"
import { TaskNotFoundError } from "../../errors"
import { getProjectConfig, getRepoDir, TANGERINE_HOME } from "../../config"
import { getActiveStreamMessages, getTaskState } from "../../tasks/task-state"
import { editQueuedPrompt, getQueuedPrompts, removeQueuedPrompt, takeQueuedPrompt, getAgentState } from "../../agent/prompt-queue"

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

interface TransientSessionLogRow {
  id: string
  task_id: string
  role: "assistant" | "thinking" | "narration"
  message_id: string
  content: string
  images: null
  from_task_id: null
  timestamp: string
  transient: true
}

function getTransientSessionLogs(taskId: string): TransientSessionLogRow[] {
  return getActiveStreamMessages(taskId).map((message) => ({
    id: `${message.role}-${message.messageId}`,
    task_id: taskId,
    role: message.role,
    message_id: message.messageId,
    content: message.content,
    images: null,
    from_task_id: null,
    timestamp: message.timestamp,
    transient: true,
  }))
}

export function sessionRoutes(deps: AppDeps): Hono {
  const app = new Hono()

  app.get("/:id/config-options", (c) => {
    const handleOptions = deps.getAgentHandle(c.req.param("id"))?.getConfigOptions?.()
    return c.json({ configOptions: handleOptions ?? getTaskState(c.req.param("id")).configOptions })
  })

  app.get("/:id/slash-commands", (c) => {
    const handleCommands = deps.getAgentHandle(c.req.param("id"))?.getSlashCommands?.()
    return c.json({ commands: handleCommands ?? getTaskState(c.req.param("id")).slashCommands })
  })

  app.get("/:id/messages", (c) => {
    const taskId = c.req.param("id")
    const limitParam = c.req.query("limit")
    const beforeIdParam = c.req.query("beforeId")

    // Paginated mode: limit specified
    if (limitParam) {
      const limit = Math.min(Math.max(1, parseInt(limitParam, 10) || 100), 500)
      const beforeId = beforeIdParam ? parseInt(beforeIdParam, 10) : undefined
      return runEffect(c,
        getSessionLogsPaginated(deps.db, taskId, limit, beforeId).pipe(
          Effect.map(({ logs, hasMore }) => ({
            messages: [
              ...logs.map(normalizeTimestamps),
              // Only include transient messages when fetching latest (no beforeId)
              ...(!beforeId ? getTransientSessionLogs(taskId).map(normalizeTimestamps) : []),
            ],
            hasMore,
          }))
        )
      )
    }

    // Legacy mode: fetch all (for backwards compatibility)
    return runEffect(c,
      getSessionLogs(deps.db, taskId).pipe(
        Effect.map((rows) => [
          ...rows.map(normalizeTimestamps),
          ...getTransientSessionLogs(taskId).map(normalizeTimestamps),
        ])
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

  app.get("/:id/queue", (c) => {
    return runEffect(c,
      getQueuedPrompts(c.req.param("id")).pipe(
        Effect.map((queuedPrompts) => ({ queuedPrompts }))
      )
    )
  })

  app.patch("/:id/queue/:promptId", async (c) => {
    const body = await c.req.json<{ text?: string; images?: import("../../agent/provider").PromptImage[]; fromTaskId?: string | null }>()
    if (body.text !== undefined && body.text.trim().length === 0 && (!body.images || body.images.length === 0)) {
      return c.json({ error: "text or images are required" }, 400)
    }
    return runEffect(c,
      editQueuedPrompt(c.req.param("id"), c.req.param("promptId"), body).pipe(
        Effect.flatMap((queuedPrompt) => queuedPrompt
          ? Effect.succeed({ queuedPrompt })
          : Effect.fail(new TaskNotFoundError({ taskId: c.req.param("promptId") })))
      )
    )
  })

  app.delete("/:id/queue/:promptId", (c) => {
    return runEffectVoid(c,
      removeQueuedPrompt(c.req.param("id"), c.req.param("promptId")).pipe(
        Effect.flatMap((removed) => removed
          ? Effect.void
          : Effect.fail(new TaskNotFoundError({ taskId: c.req.param("promptId") })))
      ),
      { status: 204 },
    )
  })

  app.post("/:id/queue/:promptId/send-now", (c) => {
    const taskId = c.req.param("id")
    const promptId = c.req.param("promptId")
    return runEffectVoid(c,
      Effect.gen(function* () {
        const entry = yield* takeQueuedPrompt(taskId, promptId)
        if (!entry) return yield* Effect.fail(new TaskNotFoundError({ taskId: promptId }))
        const agentState = yield* getAgentState(taskId)
        if (agentState === "busy") {
          yield* deps.taskManager.abortTask(taskId).pipe(Effect.catchAll(() => Effect.void))
        }
        yield* deps.taskManager.sendPrompt(taskId, entry.text, entry.images, entry.fromTaskId)
      }),
      { status: 204 },
    )
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

  app.get("/:id/permission", (c) => {
    const pending = getTaskState(c.req.param("id")).pendingPermissionRequest
    return c.json({ permissionRequest: pending ?? null })
  })

  app.post("/:id/permission", async (c) => {
    const taskId = c.req.param("id")
    const body = await c.req.json<{ requestId: string; optionId: string }>()
    if (!body.requestId || !body.optionId) {
      return c.json({ error: "requestId and optionId are required" }, 400)
    }
    const handle = deps.getAgentHandle(taskId)
    if (!handle) {
      return c.json({ error: "No active agent handle for task" }, 404)
    }
    if (!handle.respondToPermission) {
      return c.json({ error: "Agent does not support permission responses" }, 400)
    }
    handle.respondToPermission(body.requestId, body.optionId)
    return c.json({ ok: true })
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
