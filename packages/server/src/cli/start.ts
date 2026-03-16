// CLI entrypoint: loads config, initializes subsystems, starts the server.
// Logs startup sequence so boot failures are diagnosable.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { loadConfig, getProjectConfig, TANGERINE_HOME } from "../config"
import { getDb } from "../db/index"
import { createTask as dbCreateTask, getTask, listTasks, updateTask } from "../db/queries"
import type { TaskRow } from "../db/types"
import { VMPoolManager } from "../vm/pool"
import { createApp } from "../api/app"
import type { AppDeps } from "../api/app"
import { DEFAULT_API_PORT } from "@tangerine/shared"
import * as taskManager from "../tasks/manager"
import type { TaskManagerDeps } from "../tasks/manager"
import { onTaskEvent, onStatusChange } from "../tasks/events"

const log = createLogger("cli")

export async function start(): Promise<void> {
  const startSpan = log.startOp("server-start")

  try {
    const config = loadConfig()
    const projectNames = config.config.projects.map((p) => p.name)
    log.info("Config loaded", { projects: projectNames, home: TANGERINE_HOME })

    const db = getDb()
    log.info("Database initialized")

    const pool = new VMPoolManager(db, { slots: [] })

    // Wire task manager with real DB deps and stubbed infra deps
    const tmDeps: TaskManagerDeps = {
      insertTask: (task) => dbCreateTask(db, task),
      updateTask: (taskId, updates) => updateTask(db, taskId, updates) as Effect.Effect<TaskRow | null, Error>,
      getTask: (taskId) => getTask(db, taskId),
      listTasks: (filter) => listTasks(db, filter),
      getProjectConfig: (projectId) => {
        const p = getProjectConfig(config.config, projectId)
        if (!p) return undefined
        // Ensure preview is always defined for lifecycle
        return { ...p, preview: p.preview ?? { port: 3000 } }
      },
      credentialConfig: config.credentials,
      // Infra deps — stubbed until VM layer is fully wired
      lifecycleDeps: {
        acquireVm: () => Effect.fail(new Error("VM layer not wired yet")),
        sshExec: () => Effect.fail(new Error("VM layer not wired yet") as never),
        waitForSsh: () => Effect.fail(new Error("VM layer not wired yet") as never),
        copyAuthJson: () => Effect.fail(new Error("VM layer not wired yet") as never),
        injectCredentials: () => Effect.fail(new Error("VM layer not wired yet") as never),
        createTunnel: () => Effect.fail(new Error("VM layer not wired yet") as never),
        createOpencodeSession: () => Effect.fail(new Error("VM layer not wired yet") as never),
        waitForHealth: () => Effect.fail(new Error("VM layer not wired yet") as never),
        updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid),
      },
      cleanupDeps: {
        getSessionMessages: () => Effect.succeed([]),
        persistMessages: () => Effect.void,
        sshExec: () => Effect.fail(new Error("VM layer not wired yet") as never),
        releaseVm: () => Effect.void,
        getTask: (taskId) => getTask(db, taskId),
      },
      retryDeps: {
        updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid),
      },
      abortAgent: () => Effect.fail(new Error("VM layer not wired yet") as never),
    }

    const deps: AppDeps = {
      db,
      taskManager: {
        createTask: (params) =>
          taskManager.createTask(tmDeps, { source: params.source as taskManager.TaskSource, projectId: params.projectId, title: params.title, description: params.description, sourceId: params.sourceId, sourceUrl: params.sourceUrl }).pipe(
            Effect.mapError((e) => ({ _tag: "TaskError" as const, message: e.message }))
          ),
        cancelTask: (taskId) => taskManager.cancelTask(tmDeps, taskId).pipe(
          Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
        ),
        completeTask: (taskId) => taskManager.completeTask(tmDeps, taskId).pipe(
          Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
        ),
        sendPrompt: (taskId, text) => {
          taskManager.queuePrompt(taskId, text)
          return Effect.void
        },
        abortTask: (taskId) => taskManager.abortAgent(tmDeps, taskId).pipe(
          Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
        ),
        onTaskEvent,
        onStatusChange,
      },
      pool,
      config,
    }

    const { app, websocket } = createApp(deps)
    const port = Number(process.env.PORT ?? DEFAULT_API_PORT)

    log.info("Server starting", { port })

    const hostname = process.env.HOST ?? "0.0.0.0"

    Bun.serve({
      hostname,
      port,
      fetch: app.fetch,
      websocket,
    })

    startSpan.end({ port, projects: projectNames })

    const shutdown = async (signal: string) => {
      log.info("Shutdown signal received", { signal })
      process.exit(0)
    }

    process.on("SIGINT", () => shutdown("SIGINT"))
    process.on("SIGTERM", () => shutdown("SIGTERM"))
  } catch (err) {
    startSpan.fail(err)
    process.exit(1)
  }
}

// Run if invoked directly
if (import.meta.main) {
  start()
}
