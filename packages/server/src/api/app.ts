// Hono API server: REST + WebSocket + webhook handlers.
// Error handler logs structured context for debugging API failures.

import { Effect } from "effect"
import { Hono } from "hono"
import { logger as honoLogger } from "hono/logger"
import { serveStatic, createBunWebSocket } from "hono/bun"
import { createLogger } from "../logger"
import type { AppConfig } from "../config"
import type { Database } from "bun:sqlite"
import type { TaskRow } from "../db/types"
import type { TaskSource } from "../tasks/manager"
import { verifyWebhookSignature, processWebhookPayload } from "../integrations/github"
import type { WebhookIssuePayload } from "../integrations/github"
import { taskRoutes } from "./routes/tasks"
import { sessionRoutes } from "./routes/sessions"
import { systemRoutes } from "./routes/system"
import { projectRoutes } from "./routes/project"
import { testRoutes } from "./routes/test"
import { wsRoutes } from "./routes/ws"
import { terminalWsRoutes } from "./routes/terminal-ws"

const log = createLogger("api")

// Tagged error constraint — all Effect errors flowing through route handlers
// must carry a _tag for HTTP status mapping in effect-helpers
interface TaggedError { _tag: string; message?: string }

// Shared dependency bag passed to all route modules
export interface AppDeps {
  db: Database
  taskManager: {
    createTask(params: { source: TaskSource; projectId: string; title: string; type?: import("@tangerine/shared").TaskType; description?: string; sourceId?: string; sourceUrl?: string; provider?: string; model?: string; reasoningEffort?: string; branch?: string; parentTaskId?: string; images?: import("../agent/provider").PromptImage[]; cronExpression?: string; scheduleEnabled?: boolean }): Effect.Effect<TaskRow, TaggedError>
    cancelTask(taskId: string): Effect.Effect<void, TaggedError>
    completeTask(taskId: string): Effect.Effect<void, TaggedError>
    resolveTask(taskId: string): Effect.Effect<void, TaggedError>
    sendPrompt(taskId: string, text: string, images?: import("../agent/provider").PromptImage[]): Effect.Effect<void, TaggedError>
    abortTask(taskId: string): Effect.Effect<void, TaggedError>
    changeConfig(taskId: string, config: { model?: string; reasoningEffort?: string }): Effect.Effect<void, TaggedError>
    cleanupTask(taskId: string): Effect.Effect<void, TaggedError>
    ensureOrchestrator(projectId: string, provider?: string, model?: string, reasoningEffort?: string): Effect.Effect<TaskRow, TaggedError>
    startTask(taskId: string): Effect.Effect<void, TaggedError>
    onTaskEvent(taskId: string, handler: (data: unknown) => void): () => void
    onStatusChange(taskId: string, handler: (status: string) => void): () => void
  }
  orphanCleanup: {
    findOrphans(): Effect.Effect<Array<{ id: string; title: string; status: string; worktreePath: string }>, TaggedError>
    cleanupOrphans(): Effect.Effect<number, TaggedError>
  }
  configStore: {
    read(): import("../config").RawConfig
    write(config: import("../config").RawConfig): void
  }
  config: AppConfig
}

export function createApp(deps: AppDeps): { app: Hono; websocket: ReturnType<typeof createBunWebSocket>["websocket"] } {
  const app = new Hono()
  const { upgradeWebSocket, websocket } = createBunWebSocket()

  // Hono's built-in request logger for HTTP access logs
  app.use("*", honoLogger())

  // Wire route modules
  app.route("/api", systemRoutes(deps))
  app.route("/api/tasks", taskRoutes(deps))
  app.route("/api/tasks", sessionRoutes(deps))
  app.route("/api/projects", projectRoutes(deps))

  // Test-only routes — returns 404 unless TEST_MODE=1
  app.route("/api/test", testRoutes(deps))

  app.route("/api/tasks", wsRoutes(deps, upgradeWebSocket))
  app.route("/api/tasks", terminalWsRoutes(deps, upgradeWebSocket))

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

    const payload = JSON.parse(rawBody) as WebhookIssuePayload
    const event = c.req.header("x-github-event") ?? ""
    const trigger = deps.config.config.integrations?.github?.trigger

    const result = await processWebhookPayload(
      payload,
      event,
      deps.config.config.projects,
      trigger,
      async (params) => {
        const exit = await Effect.runPromiseExit(deps.taskManager.createTask(params))
        return exit._tag === "Success" ? { id: exit.value.id } : null
      },
    )

    if ("error" in result) {
      return c.json({ error: result.error }, 500)
    }
    if (!result.handled) {
      if (result.reason.startsWith("no project matches")) {
        log.warn("Webhook received for unknown repo", { reason: result.reason })
      }
      return c.json({ received: true, ignored: true }, 202)
    }
    return c.json({ received: true, taskId: result.taskId }, 202)
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
