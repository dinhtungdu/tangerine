// Hono API server: REST + WebSocket + webhook handlers.
// Error handler logs structured context for debugging API failures.

import { Effect } from "effect"
import { Hono } from "hono"
import { logger as honoLogger } from "hono/logger"
import { serveStatic } from "hono/bun"
import { createLogger } from "../logger"
import type { AppConfig } from "../config"
import type { Database } from "bun:sqlite"
import type { TaskRow } from "../db/types"
import type { TaskSource } from "../tasks/manager"
import { verifyWebhookSignature } from "../integrations/github"
import { taskRoutes } from "./routes/tasks"
import { sessionRoutes } from "./routes/sessions"
import { systemRoutes } from "./routes/system"
import { previewRoutes } from "./routes/preview"
import { projectRoutes } from "./routes/project"
import { wsRoutes } from "./routes/ws"
import type { WsSetup } from "./routes/ws"

const log = createLogger("api")

// Tagged error constraint — all Effect errors flowing through route handlers
// must carry a _tag for HTTP status mapping in effect-helpers
interface TaggedError { _tag: string; message?: string }

// Shared dependency bag passed to all route modules
export interface AppDeps {
  db: Database
  taskManager: {
    createTask(params: { source: TaskSource; projectId: string; title: string; description?: string; sourceId?: string; sourceUrl?: string; provider?: string; model?: string }): Effect.Effect<TaskRow, TaggedError>
    cancelTask(taskId: string): Effect.Effect<void, TaggedError>
    completeTask(taskId: string): Effect.Effect<void, TaggedError>
    sendPrompt(taskId: string, text: string): Effect.Effect<void, TaggedError>
    abortTask(taskId: string): Effect.Effect<void, TaggedError>
    onTaskEvent(taskId: string, handler: (data: unknown) => void): () => void
    onStatusChange(taskId: string, handler: (status: string) => void): () => void
  }
  pool: {
    getPoolStats(): Effect.Effect<unknown, TaggedError>
    destroyVm(vmId: string): Effect.Effect<void, TaggedError>
    reconcile(): Effect.Effect<void, TaggedError>
  }
  imageBuild: {
    start(imageName: string): { ok: true } | { ok: false; reason: string }
    startBase(): { ok: true } | { ok: false; reason: string }
    getStatus(): { status: "idle" } | { status: "building" | "success" | "failed"; imageName: string; startedAt: string; finishedAt?: string; error?: string }
  }
  devServer: {
    start(taskId: string): Effect.Effect<void, TaggedError>
    stop(taskId: string): Effect.Effect<void, TaggedError>
    status(taskId: string): Effect.Effect<{ running: boolean }, TaggedError>
  }
  configStore: {
    read(): import("../config").RawConfig
    write(config: import("../config").RawConfig): void
  }
  config: AppConfig
}

export function createApp(deps: AppDeps): { app: Hono; websocket: WsSetup["websocket"] } {
  const app = new Hono()

  // Hono's built-in request logger for HTTP access logs
  app.use("*", honoLogger())

  // Wire route modules
  app.route("/api", systemRoutes(deps))
  app.route("/api/tasks", taskRoutes(deps))
  app.route("/api/tasks", sessionRoutes(deps))
  app.route("/api/projects", projectRoutes(deps))
  app.route("/preview", previewRoutes(deps))

  const { routes: wsApp, websocket } = wsRoutes(deps)
  app.route("/api/tasks", wsApp)

  // Webhook endpoint — verifies signature, matches project by repo, creates tasks for issue events
  app.post("/webhooks/github", async (c) => {
    const rawBody = await c.req.text()

    // Verify webhook signature when a secret is configured
    const webhookSecret = deps.config.config.integrations?.github?.webhookSecret
    if (webhookSecret) {
      const signature = c.req.header("x-hub-signature-256") ?? ""
      if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
        return c.json({ error: "Invalid signature" }, 401)
      }
    }

    const payload = JSON.parse(rawBody) as {
      action: string
      issue?: {
        number: number
        title: string
        body: string | null
        html_url: string
        labels: Array<{ name: string }>
        assignee: { login: string } | null
      }
      repository?: { full_name: string }
    }

    const event = c.req.header("x-github-event")
    if (event !== "issues" || !payload.issue || !payload.repository) {
      return c.json({ received: true, ignored: true }, 202)
    }

    // Only handle actionable issue events
    const actionableActions = ["opened", "labeled", "assigned"]
    if (!actionableActions.includes(payload.action)) {
      return c.json({ received: true, ignored: true }, 202)
    }

    // Match repository to a configured project by comparing full_name against repo field
    const repoFullName = payload.repository.full_name
    const project = deps.config.config.projects.find((p) => {
      // Support both "owner/repo" and full URL formats (e.g. https://github.com/owner/repo)
      return p.repo === repoFullName || p.repo.endsWith(`/${repoFullName}`) || p.repo.endsWith(`/${repoFullName}.git`)
    })

    if (!project) {
      log.warn("Webhook received for unknown repo", { repo: repoFullName })
      return c.json({ received: true, ignored: true }, 202)
    }

    // Apply trigger filter if configured
    const trigger = deps.config.config.integrations?.github?.trigger
    if (trigger) {
      const issue = payload.issue
      if (trigger.type === "label" && !issue.labels.some((l) => l.name === trigger.value)) {
        return c.json({ received: true, ignored: true }, 202)
      }
      if (trigger.type === "assignee" && issue.assignee?.login !== trigger.value) {
        return c.json({ received: true, ignored: true }, 202)
      }
    }

    const issue = payload.issue
    const sourceId = `github:${repoFullName}#${issue.number}`

    const result = await Effect.runPromiseExit(
      deps.taskManager.createTask({
        source: "github",
        projectId: project.name,
        title: issue.title,
        description: issue.body ?? undefined,
        sourceId,
        sourceUrl: issue.html_url,
      })
    )

    if (result._tag === "Failure") {
      log.error("Webhook task creation failed", { repo: repoFullName, issue: issue.number })
      return c.json({ error: "Task creation failed" }, 500)
    }

    log.info("Task created from webhook", { taskId: result.value.id, issue: issue.number, repo: repoFullName })
    return c.json({ received: true, taskId: result.value.id }, 202)
  })

  // Serve built web dashboard if dist exists
  const webDistRoot = new URL("../../../../web/dist", import.meta.url).pathname
  app.use("/*", serveStatic({ root: webDistRoot }))
  // SPA fallback — serve index.html for client-side routes
  app.get("/*", serveStatic({ root: webDistRoot, rewriteRequestPath: () => "/index.html" }))

  // Global error handler — structured logging for all unhandled errors
  app.onError((err, c) => {
    log.error("Unhandled API error", {
      method: c.req.method,
      path: c.req.path,
      error: err.message,
      stack: err.stack?.split("\n").slice(0, 5).join("\n"),
    })
    return c.json({ error: err.message ?? "Internal server error" }, 500)
  })

  return { app, websocket }
}
