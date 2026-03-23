// CLI entrypoint: loads config, initializes subsystems, starts the server.
// Logs startup sequence so boot failures are diagnosable.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { loadConfig, getProjectConfig, TANGERINE_HOME, VM_AUTH_RELPATH, VM_USER, readRawConfig, writeRawConfig, readCredentialsFile } from "../config"
import { getDb } from "../db/index"
import { createTask as dbCreateTask, getTask, getVm, listTasks, updateTask, insertSessionLog } from "../db/queries"
import { logActivity, cleanupActivities } from "../activity"
import type { TaskRow } from "../db/types"
import { ProjectVmManager } from "../vm/project-vm"
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
import { sshExec, waitForSsh } from "../vm/ssh"
import { createTunnel, createProxyTunnel, createPreviewTunnel } from "../vm/tunnel"
import type { ProxyTunnel, PreviewTunnel } from "../vm/tunnel"
import { createProvider } from "../vm/providers/index"
import type { ProviderType as VmProviderType } from "../vm/providers/index"
import { SshError, AgentError, PromptError } from "../errors"
import { initSystemLog, cleanupSystemLogs } from "../system-log"
import { startBaseBuild, getBuildStatus } from "../image/build-service"
import { createOpenCodeProvider } from "../agent/opencode-provider"
import { createClaudeCodeProvider } from "../agent/claude-code-provider"
import type { AgentHandle } from "../agent/provider"

const log = createLogger("cli")

/** Classify agent tool name → activity type + event name */
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

// In-memory map of taskId → active AgentHandle (for cleanup and abort)
const agentHandles = new Map<string, AgentHandle>()
// In-memory map of taskId → active proxy tunnel (for cleanup)
const proxyTunnels = new Map<string, ProxyTunnel>()
// In-memory map of taskId → active API reverse tunnel (for cleanup)
const apiTunnels = new Map<string, ProxyTunnel>()
// In-memory map of taskId → lazy preview tunnel (created on first /preview/:id access)
const previewTunnels = new Map<string, PreviewTunnel>()

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

    const vmProviderName: VmProviderType = process.platform === "darwin" ? "lima" : "incus"
    const vmProvider = createProvider(vmProviderName)

    // Per-project VM manager (replaces pool)
    const vmManager = new ProjectVmManager(db, {
      provider: vmProvider,
      providerName: vmProviderName,
      region: "local",
      plan: "4cpu-8gb-20gb",
    })

    // Agent provider factories
    const openCodeFactory = createOpenCodeProvider({
      sshExec: (host, port, command) => sshExec(host, port, command),
      createTunnel,
    })
    const claudeCodeFactory = createClaudeCodeProvider()

    // Select factory based on provider type
    const getAgentFactory = (provider: string) =>
      provider === "claude-code" ? claudeCodeFactory : openCodeFactory

    // Wire task manager — extract cleanupDeps so retryDeps can reference it
    const cleanupDeps: CleanupDeps = {
      db,
      getSessionMessages: (agentPort, sessionId) =>
        Effect.tryPromise({
          try: async () => {
            const res = await fetch(`http://localhost:${agentPort}/session/${sessionId}/message`)
            if (!res.ok) throw new Error(`Failed to get messages: ${res.status}`)
            return res.json() as Promise<unknown[]>
          },
          catch: (e) => new AgentError({ message: `Failed to get messages: ${e}`, taskId: "unknown" }),
        }),
      persistMessages: (taskId, messages) =>
        Effect.gen(function* () {
          for (const msg of messages) {
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
      getTask: (taskId) => getTask(db, taskId),
      updateTask: (taskId, updates) => updateTask(db, taskId, updates),
      getVmForTask: (taskId) =>
        Effect.gen(function* () {
          const task = yield* getTask(db, taskId)
          if (!task?.vm_id) return null
          const vm = yield* getVm(db, task.vm_id)
          if (!vm?.ip || !vm.ssh_port) return null
          return { ip: vm.ip, sshPort: vm.ssh_port, status: vm.status }
        }),
      getAgentHandle: (taskId) => agentHandles.get(taskId) ?? null,
      getProxyTunnel: (taskId) => proxyTunnels.get(taskId) ?? null,
      getApiTunnel: (taskId) => apiTunnels.get(taskId) ?? null,
      getPreviewTunnel: (taskId) => previewTunnels.get(taskId) ?? null,
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
        return { ...p, preview: p.preview ?? { port: 3000 } }
      },
      credentialConfig: config.credentials,
      lifecycleDeps: {
        db,
        getOrCreateVm: (projectId, imageName) => vmManager.getOrCreateVm(projectId, imageName),
        sshExec: (host, port, command) =>
          sshExec(host, port, command).pipe(
            Effect.map((stdout) => ({ stdout, stderr: "", exitCode: 0 }))
          ),
        waitForSsh: (host, port) => waitForSsh(host, port),
        copyAuthJson: (host, port, authJsonPath) =>
          Effect.tryPromise({
            try: async () => {
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
          const envLines = Object.entries(credentials)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")
          return sshExec(host, port, `printf '%s\\n' '${envLines}' >> ~/.env`).pipe(Effect.asVoid)
        },
        createProxyTunnel: (opts) => createProxyTunnel(opts),
        // Agent factory is set dynamically per task in retryDeps.onSessionReady
        // Default to opencode — overridden by the retry wrapper
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
          // Store proxy tunnel for cleanup
          if (session.proxyTunnel) {
            proxyTunnels.set(taskId, session.proxyTunnel)
          }
          // Store API reverse tunnel for cleanup
          if (session.apiTunnel) {
            apiTunnels.set(taskId, session.apiTunnel)
          }

          // Send initial prompt immediately for new tasks (no existing logs).
          // Don't wait for idle event — it may have already fired before we subscribe.
          const hasLogs = db.prepare("SELECT 1 FROM session_logs WHERE task_id = ? LIMIT 1").get(taskId)
          if (!hasLogs) {
            const task = db.prepare("SELECT description, title FROM tasks WHERE id = ?").get(taskId) as { description: string | null; title: string } | null
            const initialPrompt = task?.description || task?.title
            if (initialPrompt) {
              // Emit user message via WebSocket so connected clients see it
              emitTaskEvent(taskId, {
                role: "user",
                content: initialPrompt,
                timestamp: new Date().toISOString(),
              })
              Effect.runPromise(
                session.agentHandle.sendPrompt(initialPrompt).pipe(Effect.catchAll(() => Effect.void))
              )
              Effect.runPromise(
                insertSessionLog(db, { task_id: taskId, role: "user", content: initialPrompt }).pipe(
                  Effect.catchAll(() => Effect.void)
                )
              )
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
      abortAgent: (agentPort, sessionId) =>
        Effect.tryPromise({
          try: async () => {
            const res = await fetch(`http://localhost:${agentPort}/session/${sessionId}/abort`, {
              method: "POST",
            })
            if (!res.ok) throw new Error(`Abort failed: ${res.status}`)
          },
          catch: (e) => new AgentError({ message: `Abort failed: ${e}`, taskId: "unknown" }),
        }),
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
            yield* insertSessionLog(db, { task_id: taskId, role: "user", content: text }).pipe(
              Effect.catchAll(() => Effect.void)
            )

            // Try agent handle first (works for both providers)
            const handle = agentHandles.get(taskId)
            if (handle) {
              yield* handle.sendPrompt(text)
              return
            }

            // Fallback: task not yet running — queue for later
            const task = yield* getTask(db, taskId)
            if (!task?.agent_port || !task.agent_session_id) {
              taskManager.queuePrompt(taskId, text)
              return
            }

            // Fallback for reconnected OpenCode sessions without handle
            yield* Effect.tryPromise({
              try: async () => {
                const res = await fetch(
                  `http://localhost:${task.agent_port}/session/${task.agent_session_id}/prompt_async`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ parts: [{ type: "text", text }] }),
                  },
                )
                if (!res.ok) {
                  const err = await res.text()
                  throw new Error(`Agent prompt failed (${res.status}): ${err}`)
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
      pool: {
        getPoolStats: () => Effect.succeed({ provisioning: 0, active: 0, stopped: 0, total: 0, byProvider: {} }),
        destroyVm: (vmId: string) =>
          vmManager.destroyVmById(vmId).pipe(
            Effect.mapError((e): { _tag: string; message?: string } => ({
              _tag: "VmNotFoundError",
              message: e.message,
            })),
          ),
        reprovisionTasksForVm: (vmId: string) => {
          // Check if branch exists on remote using git ls-remote from host
          const checkRemoteBranch = (branch: string) =>
            Effect.tryPromise({
              try: async () => {
                // Find the repo URL from any task referencing this VM
                const task = db.prepare("SELECT repo_url FROM tasks WHERE vm_id = ? AND branch = ? LIMIT 1").get(vmId, branch) as { repo_url: string } | null
                if (!task?.repo_url) return false
                const proc = Bun.spawn(["git", "ls-remote", "--heads", task.repo_url, branch], { stdout: "pipe", stderr: "pipe" })
                const stdout = await new Response(proc.stdout).text()
                await proc.exited
                return stdout.trim().length > 0
              },
              catch: () => new Error("ls-remote failed"),
            })

          return taskManager.reprovisionTasksForVm(tmDeps, vmId, checkRemoteBranch).pipe(
            Effect.mapError((e): { _tag: string; message?: string } => ({
              _tag: "TaskError",
              message: e.message,
            })),
          )
        },
        resumeOrphanedTasks: () =>
          taskManager.resumeOrphanedTasks(tmDeps).pipe(
            Effect.mapError((e): { _tag: string; message?: string } => ({
              _tag: "TaskError",
              message: e.message,
            })),
          ),
        reconcile: () => Effect.void,
      },
      imageBuild: {
        startBase: startBaseBuild,
        getStatus: getBuildStatus,
      },
      devServer: {
        start: (taskId) =>
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
            const workdir = task.worktree_path ?? "/workspace/repo"
            yield* sshExec(vm.ip, vm.ssh_port, `fuser -k ${previewPort}/tcp 2>/dev/null || true`).pipe(Effect.catchAll(() => Effect.void))
            yield* sshExec(vm.ip, vm.ssh_port,
              `cd ${workdir} && nohup node server.js > /tmp/dev-server.log 2>&1 &`
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
      getOrCreatePreviewPort: (taskId) =>
        Effect.gen(function* () {
          const task = yield* getTask(db, taskId)
          if (!task) return yield* Effect.fail({ _tag: "TaskNotFoundError" as const, message: "Task not found" })

          // Return cached port if tunnel already exists
          if (task.preview_port) {
            const existing = previewTunnels.get(taskId)
            if (existing) return task.preview_port
          }

          if (!task.vm_id) return yield* Effect.fail({ _tag: "TaskNotFoundError" as const, message: "Task has no VM" })
          const vm = yield* getVm(db, task.vm_id)
          if (!vm?.ip || !vm.ssh_port) return yield* Effect.fail({ _tag: "VmNotFoundError" as const, message: "VM not found" })

          const project = getProjectConfig(config.config, task.project_id)
          const remotePort = project?.preview?.port ?? 3000

          const tunnel = yield* createPreviewTunnel({
            vmIp: vm.ip,
            sshPort: vm.ssh_port,
            remotePort,
          }).pipe(Effect.mapError((e) => ({ _tag: "TunnelError" as const, message: e.message })))

          previewTunnels.set(taskId, tunnel)
          yield* updateTask(db, taskId, { preview_port: tunnel.localPort }).pipe(
            Effect.catchAll(() => Effect.void)
          )
          return tunnel.localPort
        }),
      sshExec: (host, port, command) =>
        sshExec(host, port, command).pipe(
          Effect.mapError((e) => ({ _tag: "SshError" as const, message: e.message }))
        ),
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
      refreshCredentials: () =>
        Effect.gen(function* () {
          // Re-read credentials from dotfile + env
          const dotfile = readCredentialsFile()
          const freshCreds: Record<string, string> = {}
          const apiKey = process.env["ANTHROPIC_API_KEY"] ?? dotfile.ANTHROPIC_API_KEY
          const oauthToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? dotfile.CLAUDE_CODE_OAUTH_TOKEN
          const ghToken = process.env["GITHUB_TOKEN"] ?? dotfile.GITHUB_TOKEN
          const gheToken = process.env["GH_ENTERPRISE_TOKEN"] ?? dotfile.GH_ENTERPRISE_TOKEN
          const ghHost = process.env["GH_HOST"] ?? dotfile.GH_HOST

          if (apiKey) freshCreds.ANTHROPIC_API_KEY = apiKey
          if (oauthToken) freshCreds.CLAUDE_CODE_OAUTH_TOKEN = oauthToken
          if (ghToken) { freshCreds.GITHUB_TOKEN = ghToken; freshCreds.GH_TOKEN = ghToken }
          if (gheToken) freshCreds.GH_ENTERPRISE_TOKEN = gheToken
          if (ghHost && ghHost !== "github.com") freshCreds.GH_HOST = ghHost

          // Update in-memory config so new tasks use fresh creds
          config.credentials.anthropicApiKey = apiKey ?? null
          config.credentials.claudeOauthToken = oauthToken ?? null
          config.credentials.githubToken = ghToken ?? null
          config.credentials.gheToken = gheToken ?? null
          config.credentials.ghHost = ghHost ?? "github.com"

          // Find all running VMs and re-inject
          const vms = db.prepare(
            "SELECT id, ip, ssh_port FROM vms WHERE status IN ('running', 'active') AND ip IS NOT NULL AND ssh_port IS NOT NULL"
          ).all() as Array<{ id: string; ip: string; ssh_port: number }>

          let updated = 0
          let failed = 0
          for (const vm of vms) {
            const envLines = Object.entries(freshCreds).map(([k, v]) => `${k}=${v}`).join("\n")
            const result = yield* sshExec(vm.ip, vm.ssh_port, `printf '%s\\n' '${envLines}' > ~/.env`).pipe(
              Effect.map(() => true),
              Effect.catchAll(() => Effect.succeed(false)),
            )
            if (result) { updated++ } else { failed++ }
          }

          log.info("Credentials refreshed", { updated, failed, totalVms: vms.length })
          return { updated, failed }
        }).pipe(Effect.mapError((e) => ({ _tag: "CredentialError" as const, message: String(e) }))),
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

    // Reconcile existing VMs on startup (VMs persist across restarts)
    try {
      const { alive, dead } = await Effect.runPromise(vmManager.reconcileOnStartup())
      if (alive > 0 || dead > 0) log.info("VM reconciliation complete", { alive, dead })
    } catch (err) {
      log.error("VM reconciliation failed", { error: String(err) })
    }

    // Resume orphaned tasks
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
