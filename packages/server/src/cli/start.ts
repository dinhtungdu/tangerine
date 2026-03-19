// CLI entrypoint: loads config, initializes subsystems, starts the server.
// Logs startup sequence so boot failures are diagnosable.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { loadConfig, getProjectConfig, TANGERINE_HOME, VM_AUTH_RELPATH, VM_USER, readRawConfig, writeRawConfig } from "../config"
import { getDb } from "../db/index"
import { createTask as dbCreateTask, getTask, getVm, listTasks, updateTask, updateVmStatus, insertSessionLog } from "../db/queries"
import { logActivity } from "../activity"
import type { TaskRow } from "../db/types"
import { VMPoolManager } from "../vm/pool"
import { createApp } from "../api/app"
import type { AppDeps } from "../api/app"
import { DEFAULT_API_PORT } from "@tangerine/shared"
import * as taskManager from "../tasks/manager"
import type { TaskManagerDeps } from "../tasks/manager"
import { onTaskEvent, onStatusChange, emitTaskEvent } from "../tasks/events"
import { sshExec, waitForSsh } from "../vm/ssh"
import { createTunnel } from "../vm/tunnel"
import { createProvider } from "../vm/providers/index"
import type { ProviderType } from "../vm/providers/index"
import { createPoolConfig } from "../vm/pool-config"
import { getOrCreateClient } from "../agent/client"
import { SshError, AgentError, HealthCheckError, VmNotFoundError, PromptError } from "../errors"
import { initSystemLog, cleanupSystemLogs } from "../system-log"
import { startBuild, startBaseBuild, getBuildStatus } from "../image/build-service"
import { subscribeToEvents } from "../agent/events"

const log = createLogger("cli")

export async function start(): Promise<void> {
  const startSpan = log.startOp("server-start")

  try {
    const config = loadConfig()
    const projectNames = config.config.projects.map((p) => p.name)
    log.info("Config loaded", { projects: projectNames, home: TANGERINE_HOME })

    const db = getDb()
    initSystemLog(db)
    cleanupSystemLogs(db)
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
              // Ensure target directory exists before copying (~ expands via SSH)
              await Effect.runPromise(sshExec(host, port, `mkdir -p ~/$(dirname ${VM_AUTH_RELPATH})`))
              const proc = Bun.spawn(
                ["scp", "-o", "StrictHostKeyChecking=no", "-P", String(port), authJsonPath, `${VM_USER}@${host}:~/${VM_AUTH_RELPATH}`],
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
          // Write env vars to ~/.env via SSH
          const envLines = Object.entries(credentials)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")
          return sshExec(
            host,
            port,
            `printf '%s\\n' '${envLines}' >> ~/.env`,
          ).pipe(Effect.asVoid)
        },
        createTunnel: (vmIp, sshPort, ports) =>
          createTunnel({
            vmIp,
            sshPort,
            user: VM_USER,
            remoteOpencodePort: ports.opencodeVmPort,
            remotePreviewPort: ports.previewVmPort,
          }),
        createOpencodeSession: (opencodePort, title) =>
          Effect.gen(function* () {
            // Use raw HTTP — SDK wraps response in { data } which breaks .id access
            const res = yield* Effect.tryPromise({
              try: async () => {
                const r = await fetch(`http://localhost:${opencodePort}/session`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ title }),
                })
                if (!r.ok) throw new Error(`Session create failed: ${r.status}`)
                return r.json() as Promise<{ id: string }>
              },
              catch: (e) => new AgentError({ message: `OpenCode session creation failed: ${e}`, taskId: "unknown" }),
            })
            return res.id
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
                  const res = await fetch(`http://localhost:${opencodePort}/global/health`)
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
        logActivity: (taskId, type, event, content, metadata) => logActivity(db, taskId, type, event, content, metadata),
      },
      cleanupDeps: {
        getSessionMessages: (opencodePort, sessionId) =>
          Effect.tryPromise({
            try: async () => {
              const res = await fetch(`http://localhost:${opencodePort}/session/${sessionId}/message`)
              if (!res.ok) throw new Error(`Failed to get messages: ${res.status}`)
              return res.json() as Promise<unknown[]>
            },
            catch: (e) => new AgentError({ message: `Failed to get messages: ${e}`, taskId: "unknown" }),
          }),
        persistMessages: (taskId, messages) =>
          Effect.gen(function* () {
            for (const msg of messages) {
              // OpenCode message format: { info: { role }, parts: [{ type, text }] }
              const m = msg as { info?: { role?: string }; parts?: Array<{ type: string; text?: string }> }
              const role = m.info?.role ?? "assistant"
              const content = m.parts
                ?.filter((p) => p.type === "text" && p.text)
                .map((p) => p.text)
                .join("\n") ?? ""
              if (!content) continue
              yield* insertSessionLog(db, { task_id: taskId, role, content }).pipe(
                Effect.catchAll(() => Effect.void)
              )
            }
          }),
        sshExec: (host, port, command) =>
          sshExec(host, port, command).pipe(
            Effect.map((stdout) => ({ stdout, stderr: "", exitCode: 0 }))
          ),
        releaseVm: (vmId) => pool.releaseVm(vmId),
        getTask: (taskId) => getTask(db, taskId),
      },
      retryDeps: {
        updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid),
        onSessionReady: (taskId, session) => {
          // Track in-progress text parts to assemble complete messages
          const textParts = new Map<string, string>() // messageId -> accumulated text

          Effect.runPromise(
            subscribeToEvents(session.opencodePort, taskId, (eventData) => {
              const data = eventData as { type: string; properties: Record<string, unknown> }
              if (!data?.type) return

              switch (data.type) {
                // Text content streaming — accumulate parts
                case "message.part.updated": {
                  const part = data.properties.part as { type: string; text?: string; messageID?: string } | undefined
                  if (part?.type === "text" && part.text && part.messageID) {
                    textParts.set(part.messageID, part.text)
                  }
                  break
                }

                // Message completed — persist and relay to WebSocket
                case "message.updated": {
                  const info = data.properties.info as { id: string; role: string; time?: { completed?: number } } | undefined
                  if (!info?.id || !info.role) break

                  // Only persist completed assistant messages (have time.completed)
                  if (info.role === "assistant" && info.time?.completed) {
                    const text = textParts.get(info.id)
                    if (text) {
                      // Emit to WebSocket as chat message
                      emitTaskEvent(taskId, { role: "assistant", content: text, timestamp: new Date().toISOString() })

                      // Persist to session_logs for REST API
                      Effect.runPromise(
                        insertSessionLog(db, { task_id: taskId, role: "assistant", content: text }).pipe(Effect.catchAll(() => Effect.void))
                      )
                      textParts.delete(info.id)
                    }
                  }
                  break
                }

                // Agent status — relay as events the frontend understands
                case "session.status": {
                  const status = (data.properties as { status?: { type?: string } }).status
                  if (status?.type === "busy") {
                    emitTaskEvent(taskId, { event: "agent.start" })
                  } else if (status?.type === "idle") {
                    emitTaskEvent(taskId, { event: "agent.idle" })
                  }
                  break
                }
              }
            })
          ).catch((err) => {
            log.error("SSE subscription failed", { taskId, error: String(err) })
          })
        },
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

    // Pool reconciliation as an Effect for the API endpoint
    const reconcileEffect = Effect.tryPromise({
      try: async () => {
        const released = await Effect.runPromise(pool.releaseStaleVms())
        if (released > 0) log.info("Released stale VMs", { count: released })
        const reaped = await Effect.runPromise(pool.reapIdleVms())
        if (reaped > 0) log.info("Reaped idle VMs", { count: reaped })
        pool.ensureWarm()
      },
      catch: (e) => ({ _tag: "PoolError" as const, message: String(e) }),
    })

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
        sendPrompt: (taskId, text) =>
          Effect.gen(function* () {
            // Persist user message to session_logs so it survives page refresh
            yield* insertSessionLog(db, { task_id: taskId, role: "user", content: text }).pipe(
              Effect.catchAll(() => Effect.void)
            )

            const task = yield* getTask(db, taskId)
            if (!task?.opencode_port || !task.opencode_session_id) {
              // Task not yet running — queue for later
              taskManager.queuePrompt(taskId, text)
              return
            }
            yield* Effect.tryPromise({
              try: async () => {
                const res = await fetch(
                  `http://localhost:${task.opencode_port}/session/${task.opencode_session_id}/prompt_async`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ parts: [{ type: "text", text }] }),
                  },
                )
                if (!res.ok) {
                  const err = await res.text()
                  throw new Error(`OpenCode prompt failed (${res.status}): ${err}`)
                }
              },
              catch: (e) => new PromptError({ message: `Failed to send prompt: ${e}`, taskId }),
            })
          }).pipe(
            Effect.catchAll((e) => {
              log.error("sendPrompt failed", { taskId, error: String(e) })
              return Effect.void
            })
          ),
        abortTask: (taskId) => taskManager.abortAgent(tmDeps, taskId).pipe(
          Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
        ),
        onTaskEvent,
        onStatusChange,
      },
      pool: {
        getPoolStats: () => pool.getPoolStats(),
        destroyVm: (vmId: string) =>
          getVm(db, vmId).pipe(
            Effect.flatMap((vm) => {
              if (!vm) return Effect.fail(new VmNotFoundError({ vmId }))
              return Effect.tryPromise({
                try: async () => {
                  await Effect.runPromise(provider.destroyInstance(vm.id))
                  Effect.runSync(updateVmStatus(db, vm.id, "destroyed"))
                },
                catch: (e) => new VmNotFoundError({ vmId: String(e) }),
              })
            }),
            Effect.mapError((e): { _tag: string; message?: string } => {
              if (e instanceof VmNotFoundError) return { _tag: "VmNotFoundError", message: `VM ${vmId} not found` }
              return { _tag: "ProviderError", message: String(e) }
            }),
            Effect.asVoid,
          ),
        reconcile: () => reconcileEffect,
      },
      imageBuild: {
        start: startBuild,
        startBase: startBaseBuild,
        getStatus: getBuildStatus,
      },
      devServer: {
        start: (taskId) =>
          Effect.gen(function* () {
            const task = yield* getTask(db, taskId)
            if (!task?.vm_id || !task.preview_port) {
              return yield* Effect.fail({ _tag: "TaskNotFoundError" as const, message: "Task has no VM or preview port" })
            }
            const vm = yield* getVm(db, task.vm_id)
            if (!vm?.ip || !vm.ssh_port) {
              return yield* Effect.fail({ _tag: "VmNotFoundError" as const, message: "VM not found" })
            }
            const project = getProjectConfig(config.config, task.project_id)
            const previewPort = project?.preview?.port ?? 3000
            // Kill any existing process on the port, then start fresh
            yield* sshExec(vm.ip, vm.ssh_port, `fuser -k ${previewPort}/tcp 2>/dev/null || true`).pipe(Effect.catchAll(() => Effect.void))
            // Start the app backgrounded via nohup
            yield* sshExec(vm.ip, vm.ssh_port,
              `cd /workspace/repo && nohup node server.js > /tmp/dev-server.log 2>&1 &`
            ).pipe(Effect.asVoid)
          }).pipe(Effect.mapError((e) => "_tag" in e ? e : { _tag: "TaskNotFoundError" as const, message: String(e) })),

        stop: (taskId) =>
          Effect.gen(function* () {
            const task = yield* getTask(db, taskId)
            if (!task?.vm_id) {
              return yield* Effect.fail({ _tag: "TaskNotFoundError" as const, message: "Task has no VM" })
            }
            const vm = yield* getVm(db, task.vm_id)
            if (!vm?.ip || !vm.ssh_port) {
              return yield* Effect.fail({ _tag: "VmNotFoundError" as const, message: "VM not found" })
            }
            const project = getProjectConfig(config.config, task.project_id)
            const previewPort = project?.preview?.port ?? 3000
            yield* sshExec(vm.ip, vm.ssh_port, `fuser -k ${previewPort}/tcp 2>/dev/null || true`).pipe(Effect.asVoid)
          }).pipe(Effect.mapError((e) => "_tag" in e ? e : { _tag: "TaskNotFoundError" as const, message: String(e) })),

        status: (taskId) =>
          Effect.gen(function* () {
            const task = yield* getTask(db, taskId)
            if (!task?.preview_port) return { running: false }
            try {
              const res = yield* Effect.tryPromise({
                try: () => fetch(`http://localhost:${task.preview_port}/`, { signal: AbortSignal.timeout(2000) }),
                catch: () => null as never,
              })
              return { running: res.ok }
            } catch {
              return { running: false }
            }
          }).pipe(Effect.catchAll(() => Effect.succeed({ running: false }))),
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

    // Destroy leftover Lima VMs not tracked in DB (orphans from crashes/restarts)
    try {
      const limaInstances = await Effect.runPromise(provider.listInstances("tangerine-"))
      const goldenPrefix = "tangerine-golden-"
      const ephemeral = limaInstances.filter((i) => !i.id.startsWith(goldenPrefix) && i.id !== "tangerine-base")
      for (const inst of ephemeral) {
        log.info("Destroying orphaned VM", { vmId: inst.id })
        await Effect.runPromise(provider.destroyInstance(inst.id)).catch(() => {})
      }
      if (ephemeral.length > 0) log.info("Cleaned up orphaned VMs", { count: ephemeral.length })
    } catch (err) {
      log.error("Orphaned VM cleanup failed", { error: String(err) })
    }

    // Pool reconciliation: release stale VMs, reap idle VMs, provision to minReady
    const reconcile = async () => {
      try {
        const released = await Effect.runPromise(pool.releaseStaleVms())
        if (released > 0) log.info("Released stale VMs", { count: released })
        const reaped = await Effect.runPromise(pool.reapIdleVms())
        if (reaped > 0) log.info("Reaped idle VMs", { count: reaped })
        pool.ensureWarm()
      } catch (err) {
        log.error("Pool reconciliation failed", { error: String(err) })
      }
    }
    // Run reconcile first to clean up stale VMs, then resume orphans which acquire fresh VMs
    await reconcile()

    try {
      const resumed = await Effect.runPromise(taskManager.resumeOrphanedTasks(tmDeps))
      if (resumed > 0) log.info("Resumed orphaned tasks", { count: resumed })
    } catch (err) {
      log.error("Failed to resume orphaned tasks", { error: String(err) })
    }

    const reconcileInterval = setInterval(reconcile, 60_000)

    const shutdown = async (signal: string) => {
      log.info("Shutdown signal received", { signal })
      clearInterval(reconcileInterval)
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
