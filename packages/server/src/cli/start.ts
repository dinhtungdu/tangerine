// CLI entrypoint: loads config, initializes subsystems, starts the server.
// v1: No VM management. Server runs locally. Agents spawn as local processes.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { loadConfig, getProjectConfig, TANGERINE_HOME, readRawConfig, writeRawConfig } from "../config"
import { getDb } from "../db/index"
import { createTask as dbCreateTask, getTask, listTasks, updateTask, insertSessionLog } from "../db/queries"
import { logActivity, cleanupActivities } from "../activity"
import type { TaskRow } from "../db/types"
import { createApp } from "../api/app"
import type { AppDeps } from "../api/app"
import { DEFAULT_API_PORT } from "@tangerine/shared"
import * as taskManager from "../tasks/manager"
import type { TaskManagerDeps } from "../tasks/manager"
import { onTaskEvent, onStatusChange, emitTaskEvent } from "../tasks/events"
import { cleanupSession } from "../tasks/cleanup"
import type { CleanupDeps } from "../tasks/cleanup"
import { startOrphanCleanup, findOrphans, cleanupOrphans } from "../tasks/orphan-cleanup"
import type { OrphanCleanupDeps } from "../tasks/orphan-cleanup"
import { AgentError } from "../errors"
import { initSystemLog, cleanupSystemLogs } from "../system-log"
import { createOpenCodeProvider } from "../agent/opencode-provider"
import { createClaudeCodeProvider } from "../agent/claude-code-provider"
import type { AgentHandle } from "../agent/provider"

const log = createLogger("cli")

/** Classify agent tool name -> activity type + event name */
function classifyTool(toolName: string): { activityType: "file" | "system"; activityEvent: string } {
  switch (toolName) {
    case "Read": case "Glob": case "Grep":
      return { activityType: "file", activityEvent: "tool.read" }
    case "Write": case "Edit":
      return { activityType: "file", activityEvent: "tool.write" }
    case "Bash":
      return { activityType: "system", activityEvent: "tool.bash" }
    default:
      return { activityType: "system", activityEvent: "tool.other" }
  }
}

// In-memory map of taskId -> active AgentHandle (for cleanup and abort)
const agentHandles = new Map<string, AgentHandle>()
// Track which tasks have received their first prompt (for setup note injection)
const firstPromptSent = new Set<string>()

export async function start(): Promise<void> {
  const startSpan = log.startOp("server-start")

  try {
    const config = loadConfig()
    const projectNames = config.config.projects.map((p) => p.name)
    log.info("Config loaded", { projects: projectNames, home: TANGERINE_HOME })

    const db = getDb()
    initSystemLog(db)
    cleanupSystemLogs(db)
    cleanupActivities(db)
    log.info("Database initialized")

    // Agent provider factories (local — no SSH deps)
    const openCodeFactory = createOpenCodeProvider()
    const claudeCodeFactory = createClaudeCodeProvider()

    // Select factory based on provider type
    const getAgentFactory = (provider: string) =>
      provider === "claude-code" ? claudeCodeFactory : openCodeFactory

    // Wire task manager — extract cleanupDeps so retryDeps can reference it
    const cleanupDeps: CleanupDeps = {
      db,
      getTask: (taskId) => getTask(db, taskId).pipe(Effect.mapError((e) => new Error(String(e)))),
      updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid, Effect.mapError((e) => new Error(String(e)))),
      getAgentHandle: (taskId) => agentHandles.get(taskId) ?? null,
    }

    const tmDeps: TaskManagerDeps = {
      insertTask: (task) => dbCreateTask(db, task),
      updateTask: (taskId, updates) => updateTask(db, taskId, updates) as Effect.Effect<TaskRow | null, Error>,
      getTask: (taskId) => getTask(db, taskId),
      listTasks: (filter) => listTasks(db, filter),
      logActivity: (taskId, type, event, content, metadata) => logActivity(db, taskId, type, event, content, metadata),
      getProjectConfig: (projectId) => {
        const p = getProjectConfig(config.config, projectId)
        if (!p) return undefined
        return { ...p }
      },
      lifecycleDeps: {
        db,
        agentFactory: openCodeFactory,
        getTask: (taskId) => getTask(db, taskId),
        updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid),
        logActivity: (taskId, type, event, content, metadata) => logActivity(db, taskId, type, event, content, metadata),
      },
      cleanupDeps,
      retryDeps: {
        updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid),
        cleanupDeps,
        onSessionReady: (taskId, session) => {
          // Store handle for cleanup/abort
          agentHandles.set(taskId, session.agentHandle)

          // Send initial prompt immediately for new tasks (no existing logs).
          // Don't wait for idle event — it may have already fired before we subscribe.
          const hasLogs = db.prepare("SELECT 1 FROM session_logs WHERE task_id = ? LIMIT 1").get(taskId)
          if (!hasLogs) {
            const task = db.prepare("SELECT description, title FROM tasks WHERE id = ?").get(taskId) as { description: string | null; title: string } | null
            const initialPrompt = task?.description || task?.title
            if (initialPrompt) {
              // Load initial images saved during task creation (if any)
              const loadInitialImages = async () => {
                const manifestPath = `${TANGERINE_HOME}/images/${taskId}/initial.json`
                const file = Bun.file(manifestPath)
                if (!(await file.exists())) return { images: undefined, filenames: undefined }
                try {
                  const manifest = JSON.parse(await file.text()) as Array<{ filename: string; mediaType: string }>
                  if (!manifest.length) return { images: undefined, filenames: undefined }
                  const images: import("../agent/provider").PromptImage[] = []
                  const filenames: string[] = []
                  for (const entry of manifest) {
                    const imgFile = Bun.file(`${TANGERINE_HOME}/images/${taskId}/${entry.filename}`)
                    if (await imgFile.exists()) {
                      const buf = Buffer.from(await imgFile.arrayBuffer())
                      images.push({ mediaType: entry.mediaType as import("../agent/provider").PromptImage["mediaType"], data: buf.toString("base64") })
                      filenames.push(entry.filename)
                    }
                  }
                  // Clean up manifest — only needed for initial send
                  await Bun.file(manifestPath).writer().end()
                  return { images: images.length > 0 ? images : undefined, filenames: filenames.length > 0 ? filenames : undefined }
                } catch {
                  return { images: undefined, filenames: undefined }
                }
              }

              loadInitialImages().then(({ images, filenames }) => {
                // Emit user message via WebSocket so connected clients see it
                emitTaskEvent(taskId, {
                  role: "user",
                  content: initialPrompt,
                  timestamp: new Date().toISOString(),
                })
                Effect.runPromise(
                  session.agentHandle.sendPrompt(initialPrompt, images).pipe(Effect.catchAll(() => Effect.void))
                )
                Effect.runPromise(
                  insertSessionLog(db, {
                    task_id: taskId,
                    role: "user",
                    content: initialPrompt,
                    images: filenames ? JSON.stringify(filenames) : null,
                  }).pipe(
                    Effect.catchAll(() => Effect.void)
                  )
                )
              })
            }
          }

          session.agentHandle.subscribe((event) => {
            switch (event.kind) {
              case "message.streaming": {
                if (event.content) {
                  emitTaskEvent(taskId, {
                    event: "message.streaming",
                    content: event.content,
                    messageId: event.messageId,
                  })
                }
                break
              }
              case "message.complete": {
                if (event.role === "assistant") {
                  emitTaskEvent(taskId, {
                    role: "assistant",
                    content: event.content,
                    timestamp: new Date().toISOString(),
                  })
                  Effect.runPromise(
                    insertSessionLog(db, { task_id: taskId, role: "assistant", content: event.content }).pipe(
                      Effect.catchAll(() => Effect.void)
                    )
                  )
                }
                break
              }
              case "status": {
                if (event.status === "working") {
                  emitTaskEvent(taskId, { event: "agent.start" })
                } else if (event.status === "idle") {
                  emitTaskEvent(taskId, { event: "agent.idle" })
                }
                break
              }
              case "tool.start": {
                const { activityType, activityEvent } = classifyTool(event.toolName)
                Effect.runPromise(
                  logActivity(db, taskId, activityType, activityEvent, event.toolName, {
                    toolName: event.toolName,
                    toolInput: event.toolInput,
                    status: "running",
                  }).pipe(Effect.catchAll(() => Effect.void))
                )
                break
              }
              case "tool.end": {
                // Don't persist — tool.start already logged the action.
                // Just emit for real-time WS updates (e.g. clearing "in progress").
                emitTaskEvent(taskId, { event: "tool.end", toolName: event.toolName })
                break
              }
              case "thinking": {
                Effect.runPromise(
                  logActivity(db, taskId, "system", "agent.thinking", event.content).pipe(
                    Effect.catchAll(() => Effect.void)
                  )
                )
                break
              }
              case "error": {
                log.error("Agent event error", { taskId, message: event.message })
                break
              }
            }
          })
        },
      },
      abortAgent: (taskId) => {
        const handle = agentHandles.get(taskId)
        if (!handle) return Effect.fail(new AgentError({ message: "No agent handle", taskId }))
        return handle.abort()
      },
      getAgentFactory,
    }

    const orphanDeps: OrphanCleanupDeps = {
      listTasks: (filter) => listTasks(db, filter),
      cleanupDeps,
    }

    const deps: AppDeps = {
      db,
      taskManager: {
        createTask: (params) =>
          taskManager.createTask(tmDeps, {
            source: params.source as taskManager.TaskSource,
            projectId: params.projectId,
            title: params.title,
            description: params.description,
            sourceId: params.sourceId,
            sourceUrl: params.sourceUrl,
            provider: params.provider,
            model: params.model,
            reasoningEffort: params.reasoningEffort,
          }).pipe(
            Effect.tap((task) => {
              // Save initial images to disk so onSessionReady can include them
              if (!params.images?.length) return Effect.void
              return Effect.tryPromise({
                try: async () => {
                  const imagesDir = `${TANGERINE_HOME}/images/${task.id}`
                  await Bun.write(`${imagesDir}/.keep`, "")
                  const manifest: Array<{ filename: string; mediaType: string }> = []
                  for (const img of params.images!) {
                    const ext = img.mediaType.split("/")[1] ?? "png"
                    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
                    await Bun.write(`${imagesDir}/${filename}`, Buffer.from(img.data, "base64"))
                    manifest.push({ filename, mediaType: img.mediaType })
                  }
                  await Bun.write(`${imagesDir}/initial.json`, JSON.stringify(manifest))
                },
                catch: () => new Error("Failed to save initial images"),
              }).pipe(Effect.catchAll(() => Effect.void))
            }),
            Effect.mapError((e) => ({ _tag: "TaskError" as const, message: e.message }))
          ),
        cancelTask: (taskId) => taskManager.cancelTask(tmDeps, taskId).pipe(
          Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
        ),
        completeTask: (taskId) => taskManager.completeTask(tmDeps, taskId).pipe(
          Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
        ),
        sendPrompt: (taskId, text, images) =>
          Effect.gen(function* () {
            // Save images to disk and store filenames in session_logs
            let imageFilenames: string[] | undefined
            if (images && images.length > 0) {
              const imagesDir = `${TANGERINE_HOME}/images/${taskId}`
              yield* Effect.tryPromise({
                try: () => Bun.write(`${imagesDir}/.keep`, ""),
                catch: () => new Error("mkdir"),
              }).pipe(Effect.catchAll(() => Effect.void))

              imageFilenames = []
              for (const img of images) {
                const ext = img.mediaType.split("/")[1] ?? "png"
                const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
                yield* Effect.tryPromise({
                  try: () => Bun.write(
                    `${imagesDir}/${filename}`,
                    Buffer.from(img.data, "base64"),
                  ),
                  catch: () => new Error("write image"),
                }).pipe(Effect.catchAll(() => Effect.void))
                imageFilenames.push(filename)
              }
            }

            yield* insertSessionLog(db, {
              task_id: taskId,
              role: "user",
              content: text,
              images: imageFilenames ? JSON.stringify(imageFilenames) : null,
            }).pipe(
              Effect.catchAll(() => Effect.void)
            )

            // Prepend setup note to the first prompt for a task
            let promptText = text
            if (!firstPromptSent.has(taskId)) {
              firstPromptSent.add(taskId)
              const task = yield* getTask(db, taskId).pipe(Effect.catchAll(() => Effect.succeed(null)))
              if (task?.project_id) {
                const projConfig = getProjectConfig(config.config, task.project_id)
                if (projConfig?.setup) {
                  const prefix = task.id.slice(0, 8)
                  promptText = `[NOTE: Project setup is running in the background (\`${projConfig.setup}\`). ` +
                    `Before running builds, tests, or linters, check if setup is done: \`cat /tmp/tangerine-setup-${prefix}.status\` ` +
                    `(running/done/failed). Log: \`cat /tmp/tangerine-setup-${prefix}.log\`]\n\n${text}`
                }
              }
            }

            // Try agent handle first (works for both providers)
            const handle = agentHandles.get(taskId)
            if (handle) {
              yield* handle.sendPrompt(promptText, images)
              return
            }

            // No handle yet — queue for later
            taskManager.queuePrompt(taskId, promptText)
          }).pipe(
            Effect.catchAll((e) => {
              log.error("sendPrompt failed", { taskId, error: String(e) })
              return Effect.void
            })
          ),
        abortTask: (taskId) => {
          // Try handle-based abort first (works for Claude Code too)
          const handle = agentHandles.get(taskId)
          if (handle) {
            return handle.abort().pipe(
              Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
            )
          }
          return taskManager.abortAgent(tmDeps, taskId).pipe(
            Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
          )
        },
        changeConfig: (taskId, config) =>
          taskManager.changeConfig(tmDeps, taskId, config).pipe(
            Effect.mapError((e) => ({ _tag: "TaskError" as const, message: e instanceof Error ? e.message : String(e) }))
          ),
        cleanupTask: (taskId) =>
          cleanupSession(taskId, cleanupDeps).pipe(
            Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
          ),
        onTaskEvent,
        onStatusChange,
      },
      orphanCleanup: {
        findOrphans: () =>
          findOrphans(orphanDeps).pipe(
            Effect.map((tasks) => tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              worktreePath: t.worktree_path!,
            }))),
            Effect.mapError((e) => ({ _tag: "TaskError" as const, message: e.message })),
          ),
        cleanupOrphans: () =>
          cleanupOrphans(orphanDeps).pipe(
            Effect.mapError(() => ({ _tag: "TaskError" as const, message: "Cleanup failed" })),
          ),
      },
      configStore: {
        read: readRawConfig,
        write: writeRawConfig,
      },
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

    // Resume orphaned tasks (check PIDs)
    try {
      const resumed = await Effect.runPromise(taskManager.resumeOrphanedTasks(tmDeps))
      if (resumed > 0) log.info("Resumed orphaned tasks", { count: resumed })
    } catch (err) {
      log.error("Failed to resume orphaned tasks", { error: String(err) })
    }

    // Start periodic orphan worktree cleanup (every 30s)
    await Effect.runPromise(startOrphanCleanup(orphanDeps))
    log.info("Orphan worktree cleanup started")

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
