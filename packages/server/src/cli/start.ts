// CLI entrypoint: loads config, initializes subsystems, starts the local server.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { loadConfig, getProjectConfig, TANGERINE_HOME, readRawConfig, writeRawConfig, isTestMode } from "../config"
import { getDb } from "../db/index"
import { createTask as dbCreateTask, getTask, listTasks, updateTask, insertSessionLog, deleteSessionLogsByRole, markTaskResult } from "../db/queries"
import { logActivity, cleanupActivities, hasActivityEvent, updateToolActivity } from "../activity"
import type { TaskRow } from "../db/types"
import { taskHasCapability } from "../api/helpers"
import { createApp } from "../api/app"
import type { AppDeps } from "../api/app"
import { normalizeTaskType, resolveDefaultAgentId, resolveTaskTypeConfig } from "@tangerine/shared"
import * as taskManager from "../tasks/manager"
import type { TaskManagerDeps } from "../tasks/manager"
import { onTaskEvent, onStatusChange, emitTaskEvent, setAgentWorkingState, getAgentWorkingState, getEffectiveAgentStatus, recordAgentProgress, hasAgentWorkingState } from "../tasks/events"
import { cleanupSession } from "../tasks/cleanup"
import type { CleanupDeps } from "../tasks/cleanup"
import { startOrphanCleanup, findOrphans, cleanupOrphans } from "../tasks/orphan-cleanup"
import type { OrphanCleanupDeps } from "../tasks/orphan-cleanup"
import { startHealthMonitor, isTaskSuspended, clearSuspended, resetRestartCount } from "../tasks/health"
import type { HealthCheckDeps } from "../tasks/health"
import { reconnectSessionWithRetry } from "../tasks/retry"
import { AgentError } from "../errors"
import { extractPrUrl, verifyPrBranch, startPrMonitor, checkPrState } from "../tasks/pr-monitor"
import { isGithubRepo, resolveGithubSlug, getRepoForkInfo } from "../gh"
import { applyLoginShellPath, checkSystemTools } from "./system-check"
import { getStartupAuthError, getStartupAuthWarning } from "../auth"
import type { PrMonitorDeps } from "../tasks/pr-monitor"
import { initSystemLog, cleanupSystemLogs } from "../system-log"
import { getAgentHandleMeta, type AgentHandle, type AgentStreamRole } from "../agent/provider"
import { createAgentFactories } from "../agent/factories"
import { enqueue as enqueuePrompt, drainNext as drainQueuedPrompts, setAgentState as setQueuedAgentState, clearQueue } from "../agent/prompt-queue"
import { buildSystemNotes, buildPrWorkflowNote } from "../tasks/prompts"
import { appendActiveStreamMessage, clearTaskState, completeActiveStreamMessage, getTaskState } from "../tasks/task-state"
import { taskConfigUpdatesFromOptions } from "../agent/config-options"
import { DAEMON_FATAL_EXIT_CODE } from "../daemon-exit"
const log = createLogger("cli")

/** Resolve custom system prompt for a task type from project config. */
function resolveCustomSystemPrompt(projConfig: ReturnType<typeof getProjectConfig>, taskType: string | null | undefined): string | undefined {
  if (!projConfig) return undefined
  return resolveTaskTypeConfig(projConfig, normalizeTaskType(taskType)).systemPrompt
}

/** Classify agent tool name -> activity type + event name.
 * Case-insensitive because ACP agents choose their own tool-name casing. */
function classifyTool(toolName: string): { activityType: "file" | "system"; activityEvent: string } {
  switch (toolName.toLowerCase()) {
    case "read": case "glob": case "grep":
      return { activityType: "file", activityEvent: "tool.read" }
    case "write": case "edit":
      return { activityType: "file", activityEvent: "tool.write" }
    case "bash":
      return { activityType: "system", activityEvent: "tool.bash" }
    default:
      return { activityType: "system", activityEvent: "tool.other" }
  }
}

export async function applySystemPromptIfSupported(handle: AgentHandle, notes: string[], alreadyApplied = false): Promise<boolean> {
  if (alreadyApplied) return true
  if (!handle.setSystemPrompt || notes.length === 0) return false
  try {
    return await Effect.runPromise(handle.setSystemPrompt(notes.join("\n")))
  } catch {
    return false
  }
}

/**
 * Try to save a detected PR URL for a task — checks "pr-create" capability,
 * verifies branch match, then persists to DB and emits activity. No-op if the
 * task lacks the capability or the branch doesn't match.
 */
function trySavePrUrl(
  db: import("bun:sqlite").Database,
  taskId: string,
  prUrl: string,
  source: "message" | "tool",
) {
  const taskRow = db.prepare("SELECT branch, type, capabilities FROM tasks WHERE id = ?")
    .get(taskId) as { branch: string | null; type: string; capabilities: string | null } | null
  if (!taskRow || !taskHasCapability(taskRow.type, taskRow.capabilities, "pr-create")) return

  const taskBranch = taskRow.branch
  Effect.runPromise(
    verifyPrBranch(prUrl, taskBranch ?? "").pipe(
      Effect.tap((matches) => Effect.sync(() => {
        if (!matches) { log.warn("PR branch mismatch, ignoring", { taskId, prUrl, taskBranch }); return }
        getTaskState(taskId).prUrlSaved = true
        // Check PR state and save both URL and status (null if lookup fails)
        Effect.runPromise(
          checkPrState(prUrl).pipe(
            Effect.tap((prStatus) =>
              updateTask(db, taskId, { pr_url: prUrl, pr_status: prStatus }).pipe(Effect.catchAll(() => Effect.void))
            ),
            Effect.catchAll(() => updateTask(db, taskId, { pr_url: prUrl }).pipe(Effect.catchAll(() => Effect.void)))
          )
        )
        Effect.runPromise(logActivity(db, taskId, "lifecycle", "pr.created", `PR created: ${prUrl}`, { prUrl }).pipe(Effect.catchAll(() => Effect.void)))
        log.info(`PR URL detected from ${source}`, { taskId, prUrl })
      }))
    )
  )
}

// In-memory map of taskId -> active AgentHandle (for cleanup and abort)
const agentHandles = new Map<string, AgentHandle>()

/** Delay before nudging an idle agent about missing PR (ms) */
const PR_NUDGE_DELAY_MS = 15_000


/**
 * Check if the task's branch has work that warrants a PR.
 * Returns true if there are commits ahead of the default branch OR uncommitted changes.
 */
async function branchHasWork(db: import("bun:sqlite").Database, taskId: string, projectConfig: { defaultBranch?: string } | undefined): Promise<boolean> {
  const task = db.prepare("SELECT branch, worktree_path FROM tasks WHERE id = ?").get(taskId) as { branch: string | null; worktree_path: string | null } | null
  if (!task?.branch || !task?.worktree_path) return false

  const worktreePath = task.worktree_path
  const defaultBranch = projectConfig?.defaultBranch ?? "main"

  // Check for commits ahead of default branch
  const hasCommits = await (async () => {
    try {
      const proc = Bun.spawn(["git", "rev-list", "--count", `origin/${defaultBranch}..HEAD`], {
        cwd: worktreePath,
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) return false
      return parseInt(stdout.trim(), 10) > 0
    } catch {
      return false
    }
  })()

  if (hasCommits) return true

  // Check for uncommitted changes (dirty worktree)
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: worktreePath,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) return false
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

function getLastConversationLog(
  db: import("bun:sqlite").Database,
  taskId: string,
): { role: string; content: string } | null {
  return db.prepare(
    "SELECT role, content FROM session_logs WHERE task_id = ? AND role IN ('user', 'assistant') ORDER BY timestamp DESC, id DESC LIMIT 1"
  ).get(taskId) as { role: string; content: string } | null
}

function markStreamCompletionSeen(
  db: import("bun:sqlite").Database,
  taskId: string,
  role: AgentStreamRole,
  messageId: string | undefined,
): boolean {
  if (!messageId) return true
  const completionKey = `${role}:${messageId}`
  const state = getTaskState(taskId)
  if (state.completedAssistantMessageIds.has(completionKey)) return false
  const exists = db.prepare(
    "SELECT 1 FROM session_logs WHERE task_id = ? AND role = ? AND message_id = ? LIMIT 1"
  ).get(taskId, role, messageId)
  if (exists) {
    state.completedAssistantMessageIds.add(completionKey)
    return false
  }
  state.completedAssistantMessageIds.add(completionKey)
  return true
}

function isStreamRole(role: string): role is AgentStreamRole {
  return role === "assistant" || role === "narration"
}

/** Parse --config and --db flags from process.argv */
function parseStartFlags(): { configPath?: string; dbPath?: string } {
  const args = process.argv.slice(2)
  const flags: { configPath?: string; dbPath?: string } = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) {
      flags.configPath = args[++i]
    } else if (args[i] === "--db" && args[i + 1]) {
      flags.dbPath = args[++i]
    }
  }
  return flags
}

export async function start(): Promise<void> {
  const startSpan = log.startOp("server-start")

  try {
    const flags = parseStartFlags()
    // CLI flags override env vars for config/db paths
    if (flags.configPath && !process.env["TANGERINE_CONFIG"]) {
      process.env["TANGERINE_CONFIG"] = flags.configPath
    }
    if (flags.dbPath && !process.env["TANGERINE_DB"]) {
      process.env["TANGERINE_DB"] = flags.dbPath
    }

    const config = loadConfig({ configPath: flags.configPath })
    const projectNames = config.config.projects.map((p) => p.name)
    const hostname = process.env.HOST ?? "0.0.0.0"
    // Republish the resolved HTTP port so prompt builders (pr-monitor, prompts) pick up
    // the config-derived value without each call site needing to thread it through.
    process.env["TANGERINE_PORT"] = String(config.credentials.serverPort)
    log.info("Config loaded", { projects: projectNames, home: TANGERINE_HOME, testMode: isTestMode() })

    const startupAuthError = getStartupAuthError(config, hostname)
    if (startupAuthError) {
      log.error(startupAuthError)
      process.exit(1)
    }

    const startupAuthWarning = getStartupAuthWarning(config, hostname)
    if (startupAuthWarning) log.warn(startupAuthWarning)

    // Ensure process.env.PATH includes everything a login shell would have.
    // The server may be started from a context with a limited PATH (e.g. a
    // version-manager shim that only exposes node/npm). A login shell sources
    // the user's profile and picks up globally-installed tools.
    if (!isTestMode()) {
      applyLoginShellPath()
    }

    const factories = createAgentFactories({ agents: config.config.agents })
    const defaultFactory = (() => {
      const defaultAgentId = resolveDefaultAgentId(config.config, config.config.projects[0])
      const configuredDefault = factories[defaultAgentId]
      const firstFactory = Object.values(factories)[0]
      if (configuredDefault) return configuredDefault
      if (firstFactory) return firstFactory
      throw new Error("No ACP agents configured")
    })()

    // Detect system tool availability. Results are stored in systemCapabilities
    // and passed to the API so the UI can gate features on what's installed.
    let systemCapabilities: import("@tangerine/shared").SystemCapabilities = {
      git: { available: true },
      gh: { available: false, authenticated: false },
      providers: {},
    }

    if (!isTestMode()) {
      const { errors, warnings, capabilities } = checkSystemTools({
        hasGithubProject: config.config.projects.some((p) => isGithubRepo(p.repo)),
        providers: Object.entries(factories).map(([id, factory]) => ({ id, cliCommand: factory.metadata.cliCommand })),
      })

      systemCapabilities = capabilities

      for (const msg of warnings) log.warn(msg)
      if (errors.length > 0) {
        for (const msg of errors) log.error(msg)
        log.error("Fix the above issues and restart the server.")
        process.exit(1)
      }

      const availableProviders = Object.keys(capabilities.providers).filter((k) => capabilities.providers[k]!.available)
      if (warnings.length > 0) {
        log.warn(`Starting with degraded capabilities (${warnings.length} warning${warnings.length === 1 ? "" : "s"} above) — available providers: [${availableProviders.join(", ") || "none"}]`)
      } else {
        log.info(`System checks passed — available providers: [${availableProviders.join(", ") || "none"}]`)
      }
    } else {
      // In test mode, assume all tools available
      systemCapabilities.gh = { available: true, authenticated: true }
      for (const [provider, factory] of Object.entries(factories)) {
        systemCapabilities.providers[provider] = { available: true, cliCommand: factory.metadata.cliCommand }
      }
    }

    const db = getDb(flags.dbPath)
    initSystemLog(db)
    cleanupSystemLogs(db)
    cleanupActivities(db)
    log.info("Database initialized")

    // Select factory based on provider type
    const getAgentFactory = (provider: string) =>
      factories[provider] ?? defaultFactory

    const persistUserPrompt = (taskId: string, text: string, images?: import("../agent/provider").PromptImage[], fromTaskId?: string): Effect.Effect<void, never> =>
      Effect.gen(function* () {
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
          from_task_id: fromTaskId ?? null,
        }).pipe(Effect.catchAll(() => Effect.void))

        emitTaskEvent(taskId, {
          role: "user",
          content: text,
          timestamp: new Date().toISOString(),
          images: imageFilenames,
        })
      })

    // Wire task manager — extract cleanupDeps so retryDeps can reference it
    const cleanupDeps: CleanupDeps = {
      db,
      getTask: (taskId) => getTask(db, taskId).pipe(Effect.mapError((e) => new Error(String(e)))),
      updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid, Effect.mapError((e) => new Error(String(e)))),
      getAgentHandle: (taskId) => agentHandles.get(taskId) ?? null,
      removeAgentHandle: (taskId) => {
        const hadHandle = agentHandles.delete(taskId)
        log.debug("Handle removed (cleanup)", { taskId, hadHandle, handleCount: agentHandles.size })
      },
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
        tangerineConfig: config.config,
        agentFactory: defaultFactory,
        authToken: config.credentials.tangerineAuthToken,
        getTask: (taskId) => getTask(db, taskId),
        updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid),
        logActivity: (taskId, type, event, content, metadata) => logActivity(db, taskId, type, event, content, metadata),
      },
      cleanupDeps,
      retryDeps: {
        updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid),
        cleanupDeps,
        lockReconnect: (taskId) => { getTaskState(taskId).reconnecting = true },
        unlockReconnect: (taskId) => { getTaskState(taskId).reconnecting = false },
        onSessionReady: (taskId, session) => {
          // Cross-talk guard: verify the handle was created for this task.
          // If mismatch, log a critical error — this would cause messages
          // from one task to appear in another task's chat.
          const handleTaskId = (session.agentHandle as { __taskId?: string }).__taskId
          if (handleTaskId && handleTaskId !== taskId) {
            log.error("CROSS-TALK: handle taskId mismatch in onSessionReady", {
              expectedTaskId: taskId,
              handleTaskId,
              agentPid: (session.agentHandle as { __pid?: number }).__pid,
            })
          }

          // Shut down any existing handle before storing the new one (e.g. model
          // change restarts the agent with a new handle for the same task).
          const existingHandle = agentHandles.get(taskId)
          if (existingHandle && existingHandle !== session.agentHandle) {
            Effect.runPromise(existingHandle.shutdown().pipe(Effect.catchAll(() => Effect.void)))
          }
          agentHandles.set(taskId, session.agentHandle)
          log.debug("Handle stored", { taskId, pid: (session.agentHandle as { __pid?: number }).__pid, handleCount: agentHandles.size })

          const sendFn = async (_tid: string, text: string, imgs?: import("../agent/provider").PromptImage[], fromTaskId?: string, displayText?: string) => {
            await Effect.runPromise(session.agentHandle.sendPrompt(text, imgs))
            await Effect.runPromise(persistUserPrompt(_tid, displayText ?? text, imgs, fromTaskId))
          }
          const drainQueuedOnce = () => Effect.runPromise(
            drainQueuedPrompts(taskId, sendFn).pipe(
              Effect.catchAll((error) => {
                log.error("Failed to drain queued prompt", { taskId, error: error.message })
                return Effect.void
              })
            )
          )

          // Hydrate in-memory tracking from DB (lost on restart)
          const taskMeta = db.prepare("SELECT pr_url, context_tokens, context_window_max FROM tasks WHERE id = ?").get(taskId) as { pr_url: string | null; context_tokens: number; context_window_max: number | null } | null
          const s = getTaskState(taskId)
          s.contextTokens = taskMeta?.context_tokens ?? 0
          s.contextWindowMax = taskMeta?.context_window_max ?? null
          if (taskMeta?.pr_url) {
            s.prUrlSaved = true
            s.prNudgeSent = true
          }

          // Send initial prompt for new tasks, or reconnect nudge for existing ones.
          // Key distinction: if the agent never responded (e.g. killed by rapid model
          // change before processing the prompt), re-send the full initial prompt —
          // a nudge won't work because the new session has no conversation context.
          const hasLogs = db.prepare("SELECT 1 FROM session_logs WHERE task_id = ? LIMIT 1").get(taskId)
          const hasAssistantResponse = hasLogs
            ? db.prepare("SELECT 1 FROM session_logs WHERE task_id = ? AND role = 'assistant' LIMIT 1").get(taskId)
            : null
          const lastLog = hasLogs ? getLastConversationLog(db, taskId) : null

          // If agent already responded at least once, system prompt was applied in a prior session.
          // Set this for ALL resumed sessions, not just the reconnect-nudge path.
          if (hasAssistantResponse) {
            s.systemPromptApplied = true
          }

          if (hasLogs && hasAssistantResponse && lastLog?.role === "user" && !getTaskState(taskId).idleWake) {
            // Reconnect after server restart or model change — agent had conversation context.
            // Skip for idle-wake: the user's new message is already queued via drainQueuedPrompts.
            const sendReconnectNudge = async () => {
              try {
                // Wait for the ACP agent to finish resume/load before sending a prompt.
                // Do NOT send abort here — an idle agent may interpret it as process termination,
                // causing an immediate crash-restart loop.
                await new Promise((r) => setTimeout(r, 1500))

                const taskRow = db.prepare(
                  "SELECT title, description, type, project_id FROM tasks WHERE id = ?"
                ).get(taskId) as { title: string; description: string | null; type: string | null; project_id: string | null } | null

                const originalTask = taskRow?.description || taskRow?.title || ""
                const unansweredUserMsg = lastLog?.role === "user" ? lastLog.content : null
                const reconnectProjConfig = taskRow?.project_id ? getProjectConfig(config.config, taskRow.project_id) : undefined

                const nudgeParts = [
                  `[TANGERINE: Server restarted. You are working on: ${originalTask}]`,
                ]
                if (normalizeTaskType(taskRow?.type) === "worker" && reconnectProjConfig?.prMode !== "none") {
                  nudgeParts.push(`[NOTE: When your work is complete: ${buildPrWorkflowNote(taskId, undefined, reconnectProjConfig?.prMode)}]`)
                }
                nudgeParts.push(
                  unansweredUserMsg
                    ? `The last message you had not yet responded to was: ${unansweredUserMsg}\n\nPlease continue.`
                    : "Please continue where you left off.",
                )
                const nudge = nudgeParts.join("\n\n")

                await Effect.runPromise(
                  session.agentHandle.sendPrompt(nudge).pipe(Effect.catchAll(() => Effect.void))
                )
              } catch (err) {
                log.error("Failed to send reconnect nudge", { taskId, error: String(err) })
              }
            }
            sendReconnectNudge()
            // Drain queued prompts for reconnect — agent already has conversation context
            drainQueuedOnce()
          } else if (!hasLogs || (hasLogs && !hasAssistantResponse)) {
            // No logs at all (fresh task) or logs exist but agent never responded
            // (e.g. killed by model change before processing prompt). Either way,
            // send the full initial prompt — don't resume a nonexistent conversation.
            // Queued prompts are drained AFTER the initial prompt so the agent gets
            // its task description first.
            const isRetry = !!hasLogs // User message already saved, just re-deliver prompt
            const task = db.prepare("SELECT description, title, project_id, type FROM tasks WHERE id = ?").get(taskId) as { description: string | null; title: string; project_id: string; type: string | null } | null
            const initialPrompt = task?.description || task?.title
            if (initialPrompt) {
              // Load initial images saved during task creation (if any)
              const loadInitialImages = async () => {
                if (isRetry) return { images: undefined, filenames: undefined } // images already saved
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

              loadInitialImages().then(async ({ images, filenames }) => {
                const projConfig = task?.project_id ? getProjectConfig(config.config, task.project_id) : undefined

                const notes = buildSystemNotes(taskId, {
                  setupCommand: projConfig?.setup,
                  taskType: normalizeTaskType(task?.type),
                  prMode: projConfig?.prMode,
                  customSystemPrompt: resolveCustomSystemPrompt(projConfig, task?.type),
                  projectId: task?.project_id,
                })
                getTaskState(taskId).firstPromptSent = true

                const taskState = getTaskState(taskId)
                const usedSystemPrompt = await applySystemPromptIfSupported(session.agentHandle, notes, taskState.systemPromptApplied)
                taskState.systemPromptApplied = usedSystemPrompt
                const fullPrompt = usedSystemPrompt || notes.length === 0
                  ? initialPrompt
                  : notes.join("\n") + "\n\n" + initialPrompt

                await Effect.runPromise(setQueuedAgentState(taskId, "busy"))
                await Effect.runPromise(
                  session.agentHandle.sendPrompt(fullPrompt, images).pipe(Effect.catchAll(() => Effect.void))
                )

                // Only save to session_logs and emit on first delivery — avoid duplicates on retry
                if (!isRetry) {
                  // Log system prompt before user message for transparency
                  if (notes.length > 0) {
                    const systemPromptContent = notes.join("\n")
                    emitTaskEvent(taskId, {
                      role: "system",
                      content: systemPromptContent,
                      timestamp: new Date().toISOString(),
                    })
                    await Effect.runPromise(
                      insertSessionLog(db, {
                        task_id: taskId,
                        role: "system",
                        content: systemPromptContent,
                      }).pipe(
                        Effect.catchAll(() => Effect.void)
                      )
                    )
                  }
                  emitTaskEvent(taskId, {
                    role: "user",
                    content: initialPrompt,
                    timestamp: new Date().toISOString(),
                  })
                  await Effect.runPromise(
                    insertSessionLog(db, {
                      task_id: taskId,
                      role: "user",
                      content: initialPrompt,
                      images: filenames ? JSON.stringify(filenames) : null,
                    }).pipe(
                      Effect.catchAll(() => Effect.void)
                    )
                  )
                }

                // Now drain any queued prompts (e.g. user message sent while task was starting)
                await drainQueuedOnce()
              })
            } else {
              // No initial prompt — just drain the queue
              drainQueuedOnce()
            }
          } else {
            // Fallback: drain queued prompts for any other case
            drainQueuedOnce()
          }

          getTaskState(taskId).idleWake = false

          const subscribedHandleTaskId = (session.agentHandle as { __taskId?: string }).__taskId
          const subscribedHandlePid = (session.agentHandle as { __pid?: number }).__pid
          log.info("Subscribing to agent handle", { taskId, handleTaskId: subscribedHandleTaskId, pid: subscribedHandlePid })

          session.agentHandle.subscribe((event) => {
            try {
            switch (event.kind) {
              case "message.streaming": {
                recordAgentProgress(taskId)
                if (event.content) {
                  const role = event.role ?? "assistant"
                  const active = appendActiveStreamMessage(taskId, role, event.content, event.messageId)
                  emitTaskEvent(taskId, {
                    event: "message.streaming",
                    content: event.content,
                    messageId: active.messageId,
                    ...(role !== "assistant" ? { role } : {}),
                  })
                }
                break
              }
              case "message.complete": {
                recordAgentProgress(taskId)
                if (isStreamRole(event.role) && (event.content || event.imagePaths?.length || event.images?.length)) {
                  const completedActive = event.role === "assistant"
                    ? completeActiveStreamMessage(taskId, "assistant", "narration")
                    : completeActiveStreamMessage(taskId, "narration", "assistant")
                  const messageId = event.messageId ?? completedActive?.messageId
                  if (!markStreamCompletionSeen(db, taskId, event.role, messageId)) break

                  const emitAndInsert = (imageFilenames?: string[]) => {
                    emitTaskEvent(taskId, {
                      role: event.role,
                      content: event.content,
                      messageId,
                      timestamp: new Date().toISOString(),
                      images: imageFilenames,
                    })
                    Effect.runPromise(
                      insertSessionLog(db, {
                        task_id: taskId,
                        role: event.role,
                        message_id: messageId,
                        content: event.content,
                        images: imageFilenames ? JSON.stringify(imageFilenames) : null,
                      }).pipe(
                        Effect.catchAll(() => Effect.void)
                      )
                    )
                  }

                  if (event.imagePaths?.length) {
                    // Copy original full-size images from the worktree to the
                    // serving directory when an ACP agent reports image paths.
                    const copyImages = async () => {
                      const imagesDir = `${TANGERINE_HOME}/images/${taskId}`
                      // Resolve relative paths against the task's worktree
                      const taskRow = db.prepare("SELECT worktree_path FROM tasks WHERE id = ?").get(taskId) as { worktree_path: string | null } | null
                      const worktree = taskRow?.worktree_path
                      try {
                        await Bun.write(`${imagesDir}/.keep`, "")
                        const filenames: string[] = []
                        for (const srcPath of event.imagePaths!) {
                          const resolvedPath = srcPath.startsWith("/") ? srcPath
                            : worktree ? `${worktree}/${srcPath}` : srcPath
                          const ext = resolvedPath.split(".").pop() ?? "png"
                          const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
                          const file = Bun.file(resolvedPath)
                          if (await file.exists()) {
                            await Bun.write(`${imagesDir}/${filename}`, file)
                            filenames.push(filename)
                          }
                        }
                        return filenames.length > 0 ? filenames : undefined
                      } catch {
                        return undefined
                      }
                    }
                    copyImages().then(emitAndInsert)
                  } else if (event.images?.length) {
                    // Fallback for ACP agents that send base64 images.
                    const saveImages = async () => {
                      const imagesDir = `${TANGERINE_HOME}/images/${taskId}`
                      try {
                        await Bun.write(`${imagesDir}/.keep`, "")
                        const filenames: string[] = []
                        for (const img of event.images!) {
                          const ext = img.mediaType.split("/")[1] ?? "png"
                          const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
                          await Bun.write(`${imagesDir}/${filename}`, Buffer.from(img.data, "base64"))
                          filenames.push(filename)
                        }
                        return filenames
                      } catch {
                        return undefined
                      }
                    }
                    saveImages().then(emitAndInsert)
                  } else {
                    emitAndInsert()
                  }

                  // Track when agent produces a final result
                  if (event.role === "assistant") {
                    Effect.runPromise(
                      markTaskResult(db, taskId).pipe(Effect.catchAll(() => Effect.void))
                    )
                  }

                  // Fallback PR URL detection from agent message text
                  if (!getTaskState(taskId).prUrlSaved) {
                    const prUrl = extractPrUrl(event.content)
                    if (prUrl) trySavePrUrl(db, taskId, prUrl, "message")
                  }
                }
                break
              }
              case "status": {
                const st = getTaskState(taskId)
                if (event.status === "working") {
                  setAgentWorkingState(taskId, "working")
                  Effect.runPromise(setQueuedAgentState(taskId, "busy"))
                  emitTaskEvent(taskId, { event: "agent.start" })
                  // Cancel pending PR nudge — agent is still working
                  if (st.prNudgeTimer) {
                    clearTimeout(st.prNudgeTimer)
                    st.prNudgeTimer = undefined
                  }
                } else if (event.status === "idle") {
                  setAgentWorkingState(taskId, "idle")
                  Effect.runPromise(setQueuedAgentState(taskId, "idle"))
                  emitTaskEvent(taskId, { event: "agent.idle" })
                  // Agent completed a turn — it's alive and productive, so reset
                  // the restart counter to prevent false positives from the
                  // stability window in the health checker.
                  resetRestartCount(taskId)

                  // Persist dynamically captured session ID when the ACP agent reports it.
                  const handle = agentHandles.get(taskId)
                  const meta = handle ? getAgentHandleMeta(handle) : null
                  if (meta?.sessionId) {
                    const row = db.prepare("SELECT agent_session_id FROM tasks WHERE id = ?").get(taskId) as { agent_session_id: string | null } | null
                    if (row && row.agent_session_id !== meta.sessionId) {
                      Effect.runPromise(
                        updateTask(db, taskId, { agent_session_id: meta.sessionId }).pipe(Effect.catchAll(() => Effect.void))
                      )
                    }
                  }

                  if (!st.queuePaused) drainQueuedOnce()

                  // Schedule PR nudge if agent has commits but no PR
                  if (!st.prUrlSaved && !st.prNudgeSent) {
                    const timer = setTimeout(async () => {
                      st.prNudgeTimer = undefined
                      if (st.prUrlSaved || st.prNudgeSent) return

                      // Check DB for existing pr_url (in-memory set is lost on restart)
                      const task = db.prepare("SELECT project_id, pr_url, type, capabilities FROM tasks WHERE id = ?").get(taskId) as { project_id: string; pr_url: string | null; type: string; capabilities: string | null } | null
                      if (!task || !taskHasCapability(task.type, task.capabilities, "pr-create")) return
                      if (task?.pr_url) {
                        st.prUrlSaved = true
                        return
                      }
                      const projConfig = task?.project_id ? getProjectConfig(config.config, task.project_id) : undefined

                      // Don't nudge if prMode is "none"
                      if (projConfig?.prMode === "none") return

                      const hasWork = await branchHasWork(db, taskId, projConfig)
                      if (!hasWork || st.prUrlSaved) return

                      // Resolve upstream slug for fork repos
                      let nudgeUpstreamSlug: string | undefined
                      if (projConfig?.repo) {
                        const slug = resolveGithubSlug(projConfig.repo)
                        if (slug) {
                          try {
                            const forkInfo = await getRepoForkInfo(slug, projConfig.repo)
                            if (forkInfo.isFork && forkInfo.parentSlug) {
                              nudgeUpstreamSlug = forkInfo.parentSlug
                            }
                          } catch { /* ignore */ }
                        }
                      }

                      st.prNudgeSent = true
                      const handle = agentHandles.get(taskId)
                      if (handle) {
                        log.info("Nudging agent to create PR", { taskId })
                        Effect.runPromise(
                          handle.sendPrompt(
                            `[TANGERINE: You have uncommitted changes or commits on your branch but no pull request has been created. ` +
                            `If you have uncommitted changes, commit them first. ` +
                            `${buildPrWorkflowNote(taskId, undefined, projConfig?.prMode, nudgeUpstreamSlug)} ` +
                            `A PR is required for the task to be considered complete.]`
                          ).pipe(Effect.catchAll(() => Effect.void))
                        )
                        Effect.runPromise(
                          logActivity(db, taskId, "system", "pr.nudge", "Agent nudged to create PR").pipe(
                            Effect.catchAll(() => Effect.void)
                          )
                        )
                      }
                    }, PR_NUDGE_DELAY_MS)
                    st.prNudgeTimer = timer
                  }
                }
                break
              }
              case "tool.start": {
                recordAgentProgress(taskId)
                const { activityType, activityEvent } = classifyTool(event.toolName)
                Effect.runPromise(
                  updateToolActivity(db, taskId, {
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    toolInput: event.toolInput,
                    status: "running",
                    activityType,
                    activityEvent,
                  }).pipe(Effect.catchAll(() => Effect.void))
                )
                break
              }
              case "tool.update": {
                recordAgentProgress(taskId)
                const { activityType, activityEvent } = classifyTool(event.toolName)
                Effect.runPromise(
                  updateToolActivity(db, taskId, {
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    toolInput: event.toolInput,
                    toolResult: event.toolResult,
                    status: event.status,
                    activityType,
                    activityEvent,
                  }).pipe(Effect.catchAll(() => Effect.void))
                )
                emitTaskEvent(taskId, { event: "tool.update", toolCallId: event.toolCallId, toolName: event.toolName, toolResult: event.toolResult })
                break
              }
              case "tool.end": {
                recordAgentProgress(taskId)
                const { activityType, activityEvent } = classifyTool(event.toolName)
                Effect.runPromise(
                  updateToolActivity(db, taskId, {
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    toolResult: event.toolResult,
                    status: event.status,
                    activityType,
                    activityEvent,
                  }).pipe(Effect.catchAll(() => Effect.void))
                )
                emitTaskEvent(taskId, { event: "tool.end", toolCallId: event.toolCallId, toolName: event.toolName, toolResult: event.toolResult })

                // Detect PR URL from Bash tool results (e.g. `gh pr create` output)
                if (event.toolResult && !getTaskState(taskId).prUrlSaved) {
                  const prUrl = extractPrUrl(event.toolResult)
                  if (prUrl) trySavePrUrl(db, taskId, prUrl, "tool")
                }
                break
              }
              case "thinking.streaming": {
                recordAgentProgress(taskId)
                const active = appendActiveStreamMessage(taskId, "thinking", event.content, event.messageId)
                emitTaskEvent(taskId, {
                  event: "thinking.streaming",
                  messageId: active.messageId,
                  content: event.content,
                  timestamp: new Date().toISOString(),
                })
                break
              }
              case "thinking.complete":
              case "thinking": {
                recordAgentProgress(taskId)
                // Persist only complete thoughts; streaming chunks stay transient.
                if (!event.content.trim()) break
                const completedActive = event.kind === "thinking.complete" ? completeActiveStreamMessage(taskId, "thinking") : undefined
                emitTaskEvent(taskId, {
                  event: event.kind === "thinking.complete" ? "thinking.complete" : undefined,
                  messageId: event.kind === "thinking.complete" ? (event.messageId ?? completedActive?.messageId) : undefined,
                  role: "thinking",
                  content: event.content,
                  timestamp: new Date().toISOString(),
                })
                Effect.runPromise(
                  insertSessionLog(db, { task_id: taskId, role: "thinking", content: event.content }).pipe(
                    Effect.catchAll(() => Effect.void)
                  )
                )
                Effect.runPromise(
                  logActivity(db, taskId, "system", "agent.thinking", event.content).pipe(
                    Effect.catchAll(() => Effect.void)
                  )
                )
                break
              }
              case "content.block": {
                emitTaskEvent(taskId, {
                  event: "content.block",
                  block: event.block,
                  timestamp: new Date().toISOString(),
                })
                Effect.runPromise(
                  insertSessionLog(db, { task_id: taskId, role: "content", content: JSON.stringify(event.block) }).pipe(
                    Effect.catchAll(() => Effect.void)
                  )
                )
                break
              }
              case "plan": {
                emitTaskEvent(taskId, {
                  event: "plan",
                  entries: event.entries,
                  timestamp: new Date().toISOString(),
                })
                Effect.runPromise(
                  deleteSessionLogsByRole(db, taskId, "plan").pipe(
                    Effect.flatMap(() => insertSessionLog(db, { task_id: taskId, role: "plan", content: JSON.stringify(event.entries) })),
                    Effect.catchAll(() => Effect.void)
                  )
                )
                break
              }
              case "config.options": {
                const state = getTaskState(taskId)
                state.configOptions = event.options
                const updates = taskConfigUpdatesFromOptions(event.options)
                if (Object.keys(updates).length > 0) {
                  Effect.runPromise(
                    updateTask(db, taskId, updates, { skipUpdatedAt: true }).pipe(
                      Effect.catchAll(() => Effect.void)
                    )
                  )
                }
                emitTaskEvent(taskId, {
                  event: "config.options",
                  configOptions: event.options,
                })
                break
              }
              case "slash.commands": {
                getTaskState(taskId).slashCommands = event.commands
                emitTaskEvent(taskId, {
                  event: "slash.commands",
                  commands: event.commands,
                })
                break
              }
              case "session.info": {
                const state = getTaskState(taskId)
                state.sessionInfo = {
                  ...state.sessionInfo,
                  ...("title" in event ? { title: event.title } : {}),
                  ...("updatedAt" in event ? { updatedAt: event.updatedAt } : {}),
                  ...("metadata" in event ? { metadata: event.metadata } : {}),
                }
                emitTaskEvent(taskId, {
                  event: "session.info",
                  ...state.sessionInfo,
                })
                const content = state.sessionInfo.title ? `Session title: ${state.sessionInfo.title}` : "Session info updated"
                Effect.runPromise(
                  logActivity(db, taskId, "system", "session.info", content, state.sessionInfo).pipe(
                    Effect.catchAll(() => Effect.void)
                  )
                )
                break
              }
              case "permission.request": {
                const permissionRequest = {
                  requestId: event.requestId,
                  toolName: event.toolName,
                  toolCallId: event.toolCallId,
                  options: event.options,
                }
                getTaskState(taskId).pendingPermissionRequest = permissionRequest
                emitTaskEvent(taskId, {
                  event: "permission.request",
                  ...permissionRequest,
                })
                break
              }
              case "permission.decision": {
                getTaskState(taskId).pendingPermissionRequest = undefined
                Effect.runPromise(
                  logActivity(db, taskId, "system", "permission.decision", `Permission selected: ${event.optionName}`, {
                    toolName: event.toolName,
                    optionId: event.optionId,
                    optionName: event.optionName,
                    optionKind: event.optionKind,
                  }).pipe(Effect.catchAll(() => Effect.void))
                )
                break
              }
              case "usage": {
                // Context tokens = current context window usage (not cumulative)
                const state = getTaskState(taskId)
                const updates: Partial<TaskRow> = {}
                if (event.contextTokens != null && event.contextTokens > 0) {
                  state.contextTokens = event.contextTokens
                  updates.context_tokens = state.contextTokens
                }
                if (event.contextWindowMax != null && event.contextWindowMax > 0) {
                  state.contextWindowMax = event.contextWindowMax
                  updates.context_window_max = state.contextWindowMax
                }
                if (Object.keys(updates).length > 0) {
                  Effect.runPromise(
                    updateTask(db, taskId, updates, { skipUpdatedAt: true }).pipe(
                      Effect.catchAll(() => Effect.void)
                    )
                  )
                }
                emitTaskEvent(taskId, {
                  event: "usage",
                  contextTokens: state.contextTokens,
                  contextWindowMax: state.contextWindowMax,
                })
                break
              }
              case "error": {
                log.error("Agent event error", { taskId, message: event.message })
                getTaskState(taskId).lastError = event.message
                break
              }
            }
            } catch (err) {
              log.error("Subscribe callback error", { taskId, kind: event.kind, error: String(err) })
            }
          })

          // Ensure agentWorkingState is initialized even if status event fails
          if (!hasAgentWorkingState(taskId)) {
            setAgentWorkingState(taskId, "idle")
          }
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

    const reconnectAfterTuiFn = (taskId: string, sessionId: string) => {
      const task = Effect.runSync(getTask(db, taskId).pipe(Effect.catchAll(() => Effect.succeed(null))))
      if (!task || task.status !== "running") return
      const projectConfig = getProjectConfig(config.config, task.project_id)
      if (!projectConfig) return

      getTaskState(taskId).reconnecting = true
      const taskLifecycleDeps = { ...tmDeps.lifecycleDeps }
      const factory = factories[task.provider]
      if (factory) taskLifecycleDeps.agentFactory = factory

      Effect.runFork(
        reconnectSessionWithRetry(
          { ...task, agent_session_id: sessionId } as TaskRow,
          projectConfig,
          taskLifecycleDeps,
          tmDeps.retryDeps,
        )
      )
    }

    const deps: AppDeps = {
      db,
      taskManager: {
        createTask: ({ images, source, ...rest }) =>
          taskManager.createTask(tmDeps, { ...rest, source }).pipe(
            Effect.tap((task) => {
              // Save initial images to disk so onSessionReady can include them
              if (!images?.length) return Effect.void
              return Effect.tryPromise({
                try: async () => {
                  const imagesDir = `${TANGERINE_HOME}/images/${task.id}`
                  await Bun.write(`${imagesDir}/.keep`, "")
                  const manifest: Array<{ filename: string; mediaType: string }> = []
                  for (const img of images!) {
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
        resolveTask: (taskId) => taskManager.resolveTask(tmDeps, taskId).pipe(
          Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
        ),
        sendPrompt: (taskId, text, images, fromTaskId) =>
          Effect.gen(function* () {
            // Skip empty messages (no text and no images)
            if (!text && (!images || images.length === 0)) return

            getTaskState(taskId).queuePaused = false

            // Prepend system notes to the first prompt for a task
            let promptText = text
            if (!getTaskState(taskId).firstPromptSent) {
              getTaskState(taskId).firstPromptSent = true
              const task = yield* getTask(db, taskId).pipe(Effect.catchAll(() => Effect.succeed(null)))

              const projConfig = task?.project_id ? getProjectConfig(config.config, task.project_id) : undefined
              const notes = buildSystemNotes(taskId, {
                setupCommand: projConfig?.setup,
                taskType: normalizeTaskType(task?.type),
                prMode: projConfig?.prMode,
                customSystemPrompt: resolveCustomSystemPrompt(projConfig, task?.type),
                projectId: task?.project_id,
              })

              const taskState = getTaskState(taskId)
              const handle = agentHandles.get(taskId)
              const usedSystemPrompt = handle
                ? yield* Effect.promise(() => applySystemPromptIfSupported(handle, notes, taskState.systemPromptApplied))
                : taskState.systemPromptApplied
              taskState.systemPromptApplied = usedSystemPrompt

              if (notes.length > 0 && !taskState.systemPromptApplied) {
                promptText = notes.join("\n") + "\n\n" + text
              }
            }

            if (getAgentWorkingState(taskId) === "working") {
              yield* enqueuePrompt(taskId, promptText, images, fromTaskId, text)
              return
            }

            // Try agent handle first (works for both providers).
            // Check isAlive before writing — without this, prompts are silently
            // lost when the process died but the stale handle remains in agentHandles.
            const handle = agentHandles.get(taskId)
            const handleAlive = handle && (!handle.isAlive || handle.isAlive())
            if (handle && handleAlive) {
              const sent = yield* handle.sendPrompt(promptText, images).pipe(
                Effect.map(() => true),
                Effect.catchAll((e) => {
                  // stdin write failed (process died between isAlive check and write).
                  // Fall through to wake/queue instead of losing the prompt.
                  log.warn("sendPrompt to handle failed, will queue and restart", { taskId, error: String(e) })
                  agentHandles.delete(taskId)
                  log.debug("Handle removed (sendPrompt failed)", { taskId, handleCount: agentHandles.size })
                  return Effect.succeed(false)
                }),
              )
              if (sent) {
                yield* persistUserPrompt(taskId, text, images, fromTaskId)
                return
              }
            } else if (handle && !handleAlive) {
              const stalePid = (handle as { __pid?: number }).__pid
              log.warn("Agent handle exists but process is dead, removing stale handle", { taskId, stalePid })
              agentHandles.delete(taskId)
              log.debug("Handle removed (stale)", { taskId, stalePid, handleCount: agentHandles.size })
            }

            // Agent not reachable — either suspended (idle timeout) or crashed.
            // Restart the agent and queue the prompt for delivery once ready.
            if (!handle) {
              log.warn("Handle missing for running task", { taskId, handleCount: agentHandles.size, suspended: isTaskSuspended(taskId) })
            }
            if (isTaskSuspended(taskId)) {
              clearSuspended(taskId)
              yield* updateTask(db, taskId, { suspended: 0 }).pipe(Effect.ignoreLogged)
            }
            const task = yield* getTask(db, taskId).pipe(Effect.catchAll(() => Effect.succeed(null)))
            if (task && task.status === "running") {
              const projectConfig = task.project_id ? getProjectConfig(config.config, task.project_id) : undefined
              const wakeState = getTaskState(taskId)
              if (projectConfig && !wakeState.reconnecting) {
                log.info("Restarting dead agent on prompt", { taskId, title: task.title })
                wakeState.reconnecting = true
                // Skip reconnect nudge — user's prompt is already queued via drainQueuedPrompts
                wakeState.idleWake = true
                const taskLifecycleDeps = { ...tmDeps.lifecycleDeps, agentFactory: getAgentFactory(task.provider) }
                yield* Effect.forkDaemon(
                  reconnectSessionWithRetry(task, projectConfig, taskLifecycleDeps, tmDeps.retryDeps)
                )
              }
            }

            // Queue for delivery once the agent is ready
            yield* enqueuePrompt(taskId, promptText, images, fromTaskId, text)
          }).pipe(
            Effect.catchAll((e) => {
              log.error("sendPrompt failed", { taskId, error: String(e) })
              emitTaskEvent(taskId, { event: "error", message: `Failed to send prompt: ${String(e)}` })
              return Effect.void
            })
          ),
        abortTask: (taskId) => {
          // Mark as suspended so health check won't auto-restart.
          // The agent will wake again when the user sends a new message.
          const state = getTaskState(taskId)
          state.suspended = true
          state.queuePaused = true

          // Clear queued prompts so old messages don't replay on restart.
          // The user stopped the agent to steer — next prompt is the new intent.
          const clearEffects = Effect.all([
            clearQueue(taskId),
            setQueuedAgentState(taskId, "idle"),
          ])

          // Try handle-based abort first.
          const handle = agentHandles.get(taskId)
          if (handle) {
            return Effect.flatMap(clearEffects, () =>
              handle.abort().pipe(
                Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
              )
            )
          }
          return Effect.flatMap(clearEffects, () =>
            taskManager.abortAgent(tmDeps, taskId).pipe(
              Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
            )
          )
        },
        changeConfig: (taskId, config) =>
          taskManager.changeConfig(tmDeps, taskId, config).pipe(
            Effect.mapError((e) => ({ _tag: "TaskError" as const, message: e instanceof Error ? e.message : String(e) }))
          ),
        cleanupTask: (taskId) =>
          cleanupSession(taskId, cleanupDeps).pipe(
            Effect.tap(() => clearQueue(taskId)),
            Effect.tap(() => Effect.sync(() => {
              clearTaskState(taskId)
            })),
            Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
          ),
        startTask: (taskId) =>
          taskManager.startTask(tmDeps, taskId).pipe(
            Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
          ),
        restartTask: (taskId) =>
          taskManager.restartTask(tmDeps, taskId).pipe(
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
      getAgentHandle: (taskId) => agentHandles.get(taskId) ?? null,
      removeAgentHandle: (taskId) => {
        agentHandles.delete(taskId)
        log.debug("Handle removed (tui)", { taskId, handleCount: agentHandles.size })
      },
      getTuiCommand: (provider) => {
        const factory = factories[provider]
        if (!factory?.metadata.tuiCommand) return undefined
        return { command: factory.metadata.tuiCommand, resumeTemplate: factory.metadata.tuiResumeTemplate }
      },
      logActivity: (taskId, type, event, content, metadata) => logActivity(db, taskId, type, event, content, metadata),
      reconnectAfterTui: (taskId, sessionId) => {
        reconnectAfterTuiFn(taskId, sessionId)
      },
      onTuiExit: (taskId) => {
        const state = getTaskState(taskId)
        if (!state.tuiMode) return
        state.tuiMode = false
        emitTaskEvent(taskId, { event: "tui_mode", active: false })
        Effect.runPromise(
          logActivity(db, taskId, "lifecycle", "tui.exited", "TUI process exited, reconnecting ACP").pipe(
            Effect.catchAll(() => Effect.void),
          )
        )
        Effect.runPromise(
          insertSessionLog(db, { task_id: taskId, role: "system", content: "TUI session exited" }).pipe(
            Effect.catchAll(() => Effect.void),
          )
        )
        const task = Effect.runSync(getTask(db, taskId).pipe(Effect.catchAll(() => Effect.succeed(null))))
        if (task?.agent_session_id) {
          reconnectAfterTuiFn(taskId, task.agent_session_id)
        }
      },
      agentFactories: factories,
      systemCapabilities,
    }

    const { app, websocket } = createApp(deps)
    const port = config.credentials.serverPort
    const ssl = config.credentials.ssl

    try {
      if (ssl) {
        const sslPort = ssl.port
        log.info("Server starting with TLS", { port, sslPort })
        Bun.serve({
          hostname,
          port,
          fetch: app.fetch,
          websocket,
        })
        Bun.serve({
          hostname,
          port: sslPort,
          fetch: app.fetch,
          websocket,
          tls: {
            cert: Bun.file(ssl.cert),
            key: Bun.file(ssl.key),
          },
        })
      } else {
        log.info("Server starting", { port })
        Bun.serve({
          hostname,
          port,
          fetch: app.fetch,
          websocket,
        })
      }
    } catch (err) {
      log.error("Failed to bind server port — port may be in use", { port, error: String(err) })
      process.exit(DAEMON_FATAL_EXIT_CODE)
    }

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

    // Start PR status monitor (every 60s)
    const prMonitorDeps: PrMonitorDeps = {
      db,
      listTasks: (filter) => listTasks(db, filter),
      updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid, Effect.mapError((e) => new Error(String(e)))),
      logActivity: (taskId, type, event, content, metadata) => logActivity(db, taskId, type, event, content, metadata),
      hasActivityEvent: (taskId, event) => hasActivityEvent(db, taskId, event),
      sendPrompt: (taskId, text) => deps.taskManager.sendPrompt(taskId, text).pipe(Effect.catchAll(() => Effect.void)),
      cleanupDeps,
      getProjectRepoUrl: (projectId) => getProjectConfig(config.config, projectId)?.repo,
    }
    await Effect.runPromise(startPrMonitor(prMonitorDeps))
    log.info("PR status monitor started")

    // Start health monitor (every 30s — detects dead agent processes)
    const healthDeps: HealthCheckDeps = {
      listRunningTasks: () => listTasks(db, { status: "running" }),
      checkAgentAlive: (taskId) => Effect.sync(() => {
        const handle = agentHandles.get(taskId)
        if (!handle) {
          log.debug("checkAgentAlive: no handle", { taskId, handleCount: agentHandles.size })
          return false
        }

        // Prefer session-level health check when the ACP handle exposes one.
        if (handle.isAlive) {
          const alive = handle.isAlive()
          if (!alive) {
            log.debug("checkAgentAlive: isAlive returned false", { taskId, pid: (handle as { __pid?: number }).__pid })
          }
          return alive
        }

        // Fallback to PID check for handles without isAlive
        const pid = (handle as { __pid?: number }).__pid
        if (!pid) {
          log.debug("checkAgentAlive: no PID on handle", { taskId })
          return false
        }
        try {
          process.kill(pid, 0)
          return true
        } catch {
          log.debug("checkAgentAlive: PID dead", { taskId, pid })
          return false
        }
      }),
      restartAgent: (task) => {
        // Per-task lock: skip if a reconnect is already in progress for this task.
        // Health monitor and resumeOrphanedTasks can race — without this, both spawn
        // an ACP process and only the second handle is tracked, leaving the first orphaned.
        const restartState = getTaskState(task.id)
        if (restartState.reconnecting) {
          log.info("Reconnect already in progress, skipping duplicate", { taskId: task.id })
          return Effect.void
        }
        const provider = task.provider
        const factory = getAgentFactory(provider)
        const lifecycleDeps = { ...tmDeps.lifecycleDeps, agentFactory: factory }
        const projectConfig = task.project_id ? getProjectConfig(config.config, task.project_id) : undefined
        if (!projectConfig) {
          return Effect.fail(new Error(`No project config for ${task.project_id}`))
        }
        // lockReconnect is set here (not inside reconnectSessionWithRetry) because
        // the health monitor calls this synchronously — no forkDaemon race.
        // reconnectSessionWithRetry handles unlockReconnect via Effect.ensuring.
        restartState.reconnecting = true
        return reconnectSessionWithRetry(task, projectConfig, lifecycleDeps, tmDeps.retryDeps)
      },
      failTask: (taskId, reason) =>
        updateTask(db, taskId, { status: "failed", error: reason }).pipe(
          Effect.asVoid,
          Effect.mapError((e) => new Error(String(e))),
        ),
      suspendAgent: (taskId) => {
        const handle = agentHandles.get(taskId)
        if (!handle) return Effect.void
        const pid = (handle as { __pid?: number }).__pid
        agentHandles.delete(taskId)
        log.debug("Handle removed (suspend)", { taskId, pid, handleCount: agentHandles.size })
        return handle.shutdown().pipe(Effect.catchAll(() => Effect.void))
      },
      persistSuspended: (taskId, suspended) =>
        updateTask(db, taskId, { suspended: suspended ? 1 : 0 }).pipe(Effect.asVoid, Effect.catchAll(() => Effect.void)),
      getLastAgentError: (taskId) => getTaskState(taskId).lastError,
      isAgentWorking: (taskId) => getEffectiveAgentStatus(taskId) === "working",
      isAgentWorkingRaw: (taskId) => getAgentWorkingState(taskId) === "working",
      logSuspend: (taskId, idleMs) =>
        logActivity(db, taskId, "lifecycle", "agent.suspended", "Agent suspended due to inactivity", {
          idleMs,
          reason: "idle_timeout",
        }).pipe(Effect.asVoid, Effect.catchAll(() => Effect.void)),
      getLastRunningActivityTime: (() => {
        const stmt = db.prepare(
          "SELECT timestamp, metadata FROM activity_log WHERE task_id = ? ORDER BY id DESC LIMIT 1"
        )
        return (taskId: string) => {
          const row = stmt.get(taskId) as { timestamp: string; metadata: string | null } | null
          if (!row?.metadata) return null
          try {
            const meta = JSON.parse(row.metadata) as Record<string, unknown>
            if (meta.status !== "running") return null
            return typeof meta.lastProgressAt === "string" ? meta.lastProgressAt : row.timestamp
          } catch {
            return null
          }
        }
      })(),
      logHungTool: (taskId, hungMs) =>
        logActivity(db, taskId, "lifecycle", "agent.hung_tool", "Restarted: tool hung for >5min", {
          hungMs,
          reason: "hung_tool",
        }).pipe(Effect.asVoid, Effect.catchAll(() => Effect.void)),
      abortHungTool: (taskId) => {
        const handle = agentHandles.get(taskId)
        if (!handle) return Effect.void
        return handle.abort(true).pipe(Effect.catchAll(() => Effect.void))
      },
      getLastUserMessageTime: (() => {
        const stmt = db.prepare(
          "SELECT timestamp FROM session_logs WHERE task_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1"
        )
        return (taskId: string) => {
          const row = stmt.get(taskId) as { timestamp: string } | null
          return row?.timestamp ?? null
        }
      })(),
      completeTask: (taskId) =>
        taskManager.completeTask(tmDeps, taskId).pipe(
          Effect.asVoid,
          Effect.mapError((e) => new Error(e.message)),
        ),
      logOrphanComplete: (taskId) =>
        logActivity(db, taskId, "lifecycle", "task.orphan_completed", "Task auto-completed: agent lost but work finished (PR exists)").pipe(
          Effect.asVoid,
          Effect.catchAll(() => Effect.void),
        ),
      cleanupDeps,
    }
    await Effect.runPromise(startHealthMonitor(healthDeps))
    log.info("Health monitor started")

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
