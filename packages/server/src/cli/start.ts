// CLI entrypoint: loads config, initializes subsystems, starts the server.
// Logs startup sequence so boot failures are diagnosable.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { loadConfig, getProjectConfig, TANGERINE_HOME, VM_AUTH_PATH } from "../config"
import { getDb } from "../db/index"
import { createTask as dbCreateTask, getTask, listTasks, updateTask } from "../db/queries"
import { logActivity } from "../activity"
import type { TaskRow } from "../db/types"
import { VMPoolManager } from "../vm/pool"
import { createApp } from "../api/app"
import type { AppDeps } from "../api/app"
import { DEFAULT_API_PORT } from "@tangerine/shared"
import * as taskManager from "../tasks/manager"
import type { TaskManagerDeps } from "../tasks/manager"
import { onTaskEvent, onStatusChange } from "../tasks/events"
import { sshExec, waitForSsh } from "../vm/ssh"
import { createTunnel } from "../vm/tunnel"
import { createProvider } from "../vm/providers/index"
import type { ProviderType } from "../vm/providers/index"
import { createPoolConfig } from "../vm/pool-config"
import { getOrCreateClient } from "../agent/client"
import { SshError, AgentError, HealthCheckError } from "../errors"

const log = createLogger("cli")

export async function start(): Promise<void> {
  const startSpan = log.startOp("server-start")

  try {
    const config = loadConfig()
    const projectNames = config.config.projects.map((p) => p.name)
    log.info("Config loaded", { projects: projectNames, home: TANGERINE_HOME })

    const db = getDb()
    log.info("Database initialized")

    const providerName: ProviderType = process.platform === "darwin" ? "lima" : "incus"
    const provider = createProvider(providerName)
    const poolConfig = createPoolConfig(config, provider, providerName)
    const pool = new VMPoolManager(db, poolConfig)

    // Wire task manager with real DB deps and real VM/agent infra deps
    const tmDeps: TaskManagerDeps = {
      insertTask: (task) => dbCreateTask(db, task),
      updateTask: (taskId, updates) => updateTask(db, taskId, updates) as Effect.Effect<TaskRow | null, Error>,
      getTask: (taskId) => getTask(db, taskId),
      listTasks: (filter) => listTasks(db, filter),
      logActivity: (taskId, type, event, content, metadata) => logActivity(db, taskId, type, event, content, metadata),
      getProjectConfig: (projectId) => {
        const p = getProjectConfig(config.config, projectId)
        if (!p) return undefined
        // Ensure preview is always defined for lifecycle
        return { ...p, preview: p.preview ?? { port: 3000 } }
      },
      credentialConfig: config.credentials,
      lifecycleDeps: {
        acquireVm: (taskId) => pool.acquireVm(taskId),
        sshExec: (host, port, command) =>
          sshExec(host, port, command).pipe(
            // Adapt string return to the { stdout, stderr, exitCode } shape lifecycle expects
            Effect.map((stdout) => ({ stdout, stderr: "", exitCode: 0 }))
          ),
        waitForSsh: (host, port) => waitForSsh(host, port),
        copyAuthJson: (host, port, authJsonPath) =>
          Effect.tryPromise({
            try: async () => {
              // Ensure target directory exists before copying
              await Effect.runPromise(sshExec(host, port, `mkdir -p $(dirname ${VM_AUTH_PATH})`))
              const proc = Bun.spawn(
                ["scp", "-o", "StrictHostKeyChecking=no", "-P", String(port), authJsonPath, `agent@${host}:${VM_AUTH_PATH}`],
                { stdout: "pipe", stderr: "pipe" },
              )
              const exitCode = await proc.exited
              if (exitCode !== 0) {
                const stderr = await new Response(proc.stderr).text()
                throw new Error(`scp failed (exit ${exitCode}): ${stderr}`)
              }
            },
            catch: (e) => new SshError({ message: `copyAuthJson failed: ${e}`, host, command: "scp" }),
          }),
        injectCredentials: (host, port, credentials) => {
          // Write env vars to /home/agent/.env via SSH
          const envLines = Object.entries(credentials)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")
          return sshExec(
            host,
            port,
            `printf '%s\\n' '${envLines}' >> /home/agent/.env`,
          ).pipe(Effect.asVoid)
        },
        createTunnel: (vmIp, sshPort, ports) =>
          createTunnel({
            vmIp,
            sshPort,
            remoteOpencodePort: ports.opencodeVmPort,
            remotePreviewPort: ports.previewVmPort,
          }),
        createOpencodeSession: (opencodePort, title) =>
          Effect.gen(function* () {
            const client = yield* getOrCreateClient(`opencode-${opencodePort}`, opencodePort)
            const session = yield* Effect.tryPromise({
              try: () => client.session.create({ title }),
              catch: (e) => new AgentError({ message: `OpenCode session creation failed: ${e}`, taskId: "unknown" }),
            })
            return session.id
          }).pipe(Effect.mapError((e) => {
            if (e instanceof AgentError) return e
            return new AgentError({ message: String(e), taskId: "unknown" })
          })),
        waitForHealth: (opencodePort) =>
          Effect.tryPromise({
            try: async () => {
              const maxAttempts = 30
              for (let i = 0; i < maxAttempts; i++) {
                try {
                  const res = await fetch(`http://localhost:${opencodePort}/health`)
                  if (res.ok) return
                } catch {
                  // not ready yet
                }
                await new Promise((r) => setTimeout(r, 2000))
              }
              throw new Error(`OpenCode health check failed after ${maxAttempts} attempts`)
            },
            catch: (e) => new HealthCheckError({
              message: `Health check failed: ${e}`,
              taskId: "unknown",
              reason: "opencode_dead",
            }),
          }),
        updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid),
      },
      cleanupDeps: {
        getSessionMessages: (opencodePort, sessionId) =>
          Effect.gen(function* () {
            const client = yield* getOrCreateClient(`opencode-${opencodePort}`, opencodePort)
            return yield* Effect.tryPromise({
              try: () => client.message.list(sessionId),
              catch: (e) => new AgentError({ message: `Failed to get messages: ${e}`, taskId: "unknown" }),
            })
          }).pipe(Effect.mapError((e) => {
            if (e instanceof AgentError) return e
            return new AgentError({ message: String(e), taskId: "unknown" })
          })),
        persistMessages: () => Effect.void, // TODO: implement message persistence to DB
        sshExec: (host, port, command) =>
          sshExec(host, port, command).pipe(
            Effect.map((stdout) => ({ stdout, stderr: "", exitCode: 0 }))
          ),
        releaseVm: (vmId) => pool.releaseVm(vmId),
        getTask: (taskId) => getTask(db, taskId),
      },
      retryDeps: {
        updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid),
      },
      abortAgent: (opencodePort, sessionId) =>
        Effect.gen(function* () {
          const client = yield* getOrCreateClient(`opencode-${opencodePort}`, opencodePort)
          yield* Effect.tryPromise({
            try: () => client.session.abort(sessionId),
            catch: (e) => new AgentError({ message: `Abort failed: ${e}`, taskId: "unknown" }),
          })
        }).pipe(Effect.mapError((e) => {
          if (e instanceof AgentError) return e
          return new AgentError({ message: String(e), taskId: "unknown" })
        })),
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
