// CLI entrypoint: loads config, initializes subsystems, starts the server.
// v1: No VM management. Server runs locally. Agents spawn as local processes.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { loadConfig, getProjectConfig, TANGERINE_HOME, readRawConfig, writeRawConfig, isTestMode } from "../config"
import { getDb } from "../db/index"
import { createTask as dbCreateTask, getTask, listTasks, updateTask, insertSessionLog, markTaskResult, getDueCrons, hasActiveCronTask as dbHasActiveCronTask, updateCron } from "../db/queries"
import { logActivity, cleanupActivities, hasActivityEvent } from "../activity"
import type { TaskRow, CronRow } from "../db/types"
import { taskHasCapability } from "../api/helpers"
import { createApp } from "../api/app"
import type { AppDeps } from "../api/app"
import { DEFAULT_API_PORT, resolveTaskTypeConfig } from "@tangerine/shared"
import * as taskManager from "../tasks/manager"
import type { TaskManagerDeps } from "../tasks/manager"
import { onTaskEvent, onStatusChange, emitTaskEvent, setAgentWorkingState, getAgentWorkingState } from "../tasks/events"
import { cleanupSession } from "../tasks/cleanup"
import type { CleanupDeps } from "../tasks/cleanup"
import { startOrphanCleanup, findOrphans, cleanupOrphans } from "../tasks/orphan-cleanup"
import type { OrphanCleanupDeps } from "../tasks/orphan-cleanup"
import { startHealthMonitor, isTaskSuspended, clearSuspended, resetRestartCount } from "../tasks/health"
import { startScheduler } from "../tasks/scheduler"
import type { SchedulerDeps } from "../tasks/scheduler"
import type { HealthCheckDeps } from "../tasks/health"
import { reconnectSessionWithRetry } from "../tasks/retry"
import { AgentError } from "../errors"
import { extractPrUrl, verifyPrBranch, startPrMonitor } from "../tasks/pr-monitor"
import { isGithubRepo, resolveGithubSlug, getRepoForkInfo } from "../gh"
import { applyLoginShellPath, checkSystemTools } from "./system-check"
import { getStartupAuthError, getStartupAuthWarning } from "../auth"
import type { PrMonitorDeps } from "../tasks/pr-monitor"
import { initSystemLog, cleanupSystemLogs } from "../system-log"
import type { AgentHandle } from "../agent/provider"
import { getHandleMeta } from "../agent/opencode-provider"
import { createAgentFactories } from "../agent/factories"
import { enqueue as enqueuePrompt, drainAll as drainQueuedPrompts, clearQueue } from "../agent/prompt-queue"
import { buildSystemNotes, buildEscalationBlock, buildPrWorkflowNote } from "../tasks/prompts"
import { getTaskState, clearTaskState } from "../tasks/task-state"
const log = createLogger("cli")

/** Resolve custom system prompt for a task type from project config. */
function resolveCustomSystemPrompt(projConfig: ReturnType<typeof getProjectConfig>, taskType: string | null | undefined): string | undefined {
  if (!projConfig || !taskType) return undefined
  const tt = taskType as "worker" | "orchestrator" | "reviewer"
  return resolveTaskTypeConfig(projConfig, tt).systemPrompt
}

/** Classify agent tool name -> activity type + event name.
 * Case-insensitive so both Claude Code (PascalCase) and OpenCode (lowercase) work. */
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
        Effect.runPromise(updateTask(db, taskId, { pr_url: prUrl }).pipe(Effect.catchAll(() => Effect.void)))
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
 * Check if the task's branch has commits ahead of the default branch.
 * Returns true if there are commits that could warrant a PR.
 */
async function branchHasCommits(db: import("bun:sqlite").Database, taskId: string, projectConfig: { defaultBranch?: string } | undefined): Promise<boolean> {
  const task = db.prepare("SELECT branch, worktree_path FROM tasks WHERE id = ?").get(taskId) as { branch: string | null; worktree_path: string | null } | null
  if (!task?.branch || !task?.worktree_path) return false

  const defaultBranch = projectConfig?.defaultBranch ?? "main"
  try {
    const proc = Bun.spawn(["git", "rev-list", "--count", `origin/${defaultBranch}..HEAD`], {
      cwd: task.worktree_path,
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
}

function getLastConversationLog(
  db: import("bun:sqlite").Database,
  taskId: string,
): { role: string; content: string } | null {
  return db.prepare(
    "SELECT role, content FROM session_logs WHERE task_id = ? AND role != 'thinking' ORDER BY timestamp DESC, id DESC LIMIT 1"
  ).get(taskId) as { role: string; content: string } | null
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

    // Agent provider factories (local — no SSH deps)
    const factories = createAgentFactories()

    // Detect system tool availability. Results are stored in systemCapabilities
    // and passed to the API so the UI can gate features on what's installed.
    let systemCapabilities: import("@tangerine/shared").SystemCapabilities = {
      git: { available: true },
      gh: { available: false, authenticated: false },
      dtach: { available: false },
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
      systemCapabilities.dtach = { available: true }
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
      factories[provider as keyof typeof factories] ?? factories.opencode

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
        tangerineConfig: config.config,
        agentFactory: factories.opencode,
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

          const sendFn = async (_tid: string, text: string, imgs?: import("../agent/provider").PromptImage[]) => {
            await Effect.runPromise(session.agentHandle.sendPrompt(text, imgs).pipe(Effect.catchAll(() => Effect.void)))
          }

          // Hydrate in-memory tracking from DB (lost on restart)
          const taskMeta = db.prepare("SELECT pr_url, input_tokens, output_tokens FROM tasks WHERE id = ?").get(taskId) as { pr_url: string | null; input_tokens: number; output_tokens: number } | null
          const s = getTaskState(taskId)
          // Restore cumulative token counts so we continue accumulating after restart
          s.cumulativeInputTokens = taskMeta?.input_tokens ?? 0
          s.cumulativeOutputTokens = taskMeta?.output_tokens ?? 0
          const taskRow = db.prepare("SELECT project_id, type FROM tasks WHERE id = ?").get(taskId) as { project_id: string | null; type: string | null } | null
          const projConfig = taskRow?.project_id ? getProjectConfig(config.config, taskRow.project_id) : undefined
          s.systemPromptApplied = buildSystemNotes(taskId, {
            setupCommand: projConfig?.setup,
            taskType: taskRow?.type ?? undefined,
            prMode: projConfig?.prMode,
            customSystemPrompt: resolveCustomSystemPrompt(projConfig, taskRow?.type),
          }).length > 0
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
            ? db.prepare("SELECT 1 FROM session_logs WHERE task_id = ? AND role IN ('assistant', 'narration') LIMIT 1").get(taskId)
            : null
          const lastLog = hasLogs ? getLastConversationLog(db, taskId) : null
          if (hasLogs && hasAssistantResponse && lastLog?.role === "user" && !getTaskState(taskId).idleWake) {
            // Reconnect after server restart or model change — agent had conversation context.
            // Skip for idle-wake: the user's new message is already queued via drainQueuedPrompts.
            const sendReconnectNudge = async () => {
              try {
                // Wait for Claude Code to finish initializing before sending a prompt.
                // Do NOT send abort/SIGINT here — Claude Code is idle after resume and
                // SIGINT terminates an idle process rather than interrupting an in-progress turn,
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
                if (taskRow?.type === "worker" && reconnectProjConfig?.prMode !== "none") {
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
            Effect.runPromise(drainQueuedPrompts(taskId, sendFn))
          } else if (!hasLogs || (hasLogs && !hasAssistantResponse)) {
            // No logs at all (fresh task) or logs exist but agent never responded
            // (e.g. killed by model change before processing prompt). Either way,
            // send the full initial prompt — don't resume a nonexistent conversation.
            // Queued prompts are drained AFTER the initial prompt so the agent gets
            // its task description (including orchestrator system prompt) first.
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
                  taskType: task?.type ?? undefined,
                  prMode: projConfig?.prMode,
                  customSystemPrompt: resolveCustomSystemPrompt(projConfig, task?.type),
                })
                getTaskState(taskId).firstPromptSent = true

                // Append escalation block for worker tasks so the agent knows
                // how to escalate out-of-scope issues. Injected here (not stored
                // in DB description) to keep the UI task description clean.
                let escalationBlock = ""
                if (task?.project_id) {
                  const orchestratorRow = db.prepare(
                    "SELECT id FROM tasks WHERE project_id = ? AND type = 'orchestrator' AND status NOT IN ('done', 'failed', 'cancelled') LIMIT 1"
                  ).get(task.project_id) as { id: string } | null
                  if (orchestratorRow && orchestratorRow.id !== taskId) {
                    escalationBlock = buildEscalationBlock(orchestratorRow.id)
                  }
                }

                const taskState = getTaskState(taskId)
                const usedSystemPrompt = await applySystemPromptIfSupported(session.agentHandle, notes, taskState.systemPromptApplied)
                taskState.systemPromptApplied = usedSystemPrompt
                const fullPrompt = usedSystemPrompt || notes.length === 0
                  ? initialPrompt + escalationBlock
                  : notes.join("\n") + "\n\n" + initialPrompt + escalationBlock

                await Effect.runPromise(
                  session.agentHandle.sendPrompt(fullPrompt, images).pipe(Effect.catchAll(() => Effect.void))
                )

                // Only save to session_logs and emit on first delivery — avoid duplicates on retry
                if (!isRetry) {
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
                await Effect.runPromise(drainQueuedPrompts(taskId, sendFn))
              })
            } else {
              // No initial prompt — just drain the queue
              Effect.runPromise(drainQueuedPrompts(taskId, sendFn))
            }
          } else {
            // Fallback: drain queued prompts for any other case
            Effect.runPromise(drainQueuedPrompts(taskId, sendFn))
          }

          getTaskState(taskId).idleWake = false

          const subscribedHandleTaskId = (session.agentHandle as { __taskId?: string }).__taskId
          const subscribedHandlePid = (session.agentHandle as { __pid?: number }).__pid
          log.info("Subscribing to agent handle", { taskId, handleTaskId: subscribedHandleTaskId, pid: subscribedHandlePid })

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
                if ((event.role === "assistant" || event.role === "narration") && (event.content || event.imagePaths?.length || event.images?.length)) {
                  const role = event.role

                  const emitAndInsert = (imageFilenames?: string[]) => {
                    emitTaskEvent(taskId, {
                      role,
                      content: event.content,
                      timestamp: new Date().toISOString(),
                      images: imageFilenames,
                    })
                    Effect.runPromise(
                      insertSessionLog(db, {
                        task_id: taskId,
                        role,
                        content: event.content,
                        images: imageFilenames ? JSON.stringify(imageFilenames) : null,
                      }).pipe(
                        Effect.catchAll(() => Effect.void)
                      )
                    )
                  }

                  if (event.imagePaths?.length) {
                    // Copy original full-size images from the worktree to the
                    // serving directory. Claude Code downscales images in its
                    // stream, so we skip base64 and copy originals from disk.
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
                    // Fallback for providers that send base64 images (OpenCode)
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

                  // Track when agent produces a final result (not narration/thinking)
                  if (role === "assistant") {
                    Effect.runPromise(
                      markTaskResult(db, taskId).pipe(Effect.catchAll(() => Effect.void))
                    )
                  }

                  // Fallback PR URL detection from assistant/narration message text
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
                  emitTaskEvent(taskId, { event: "agent.start" })
                  // Cancel pending PR nudge — agent is still working
                  if (st.prNudgeTimer) {
                    clearTimeout(st.prNudgeTimer)
                    st.prNudgeTimer = undefined
                  }
                } else if (event.status === "idle") {
                  setAgentWorkingState(taskId, "idle")
                  emitTaskEvent(taskId, { event: "agent.idle" })
                  // Agent completed a turn — it's alive and productive, so reset
                  // the restart counter to prevent false positives from the
                  // stability window in the health checker.
                  resetRestartCount(taskId)

                  // Persist dynamically captured session ID (e.g. OpenCode's ses_... ID
                  // is only known after the first prompt produces NDJSON output)
                  const handle = agentHandles.get(taskId)
                  const meta = handle ? getHandleMeta(handle) : null
                  if (meta?.sessionId) {
                    const row = db.prepare("SELECT agent_session_id FROM tasks WHERE id = ?").get(taskId) as { agent_session_id: string | null } | null
                    if (row && row.agent_session_id !== meta.sessionId) {
                      Effect.runPromise(
                        updateTask(db, taskId, { agent_session_id: meta.sessionId }).pipe(Effect.catchAll(() => Effect.void))
                      )
                    }
                  }

                  // Schedule PR nudge if agent has commits but no PR (skip orchestrators)
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

                      const hasCommits = await branchHasCommits(db, taskId, projConfig)
                      if (!hasCommits || st.prUrlSaved) return

                      // Resolve upstream slug for fork repos
                      let nudgeUpstreamSlug: string | undefined
                      if (projConfig?.repo) {
                        const slug = resolveGithubSlug(projConfig.repo)
                        if (slug) {
                          try {
                            const forkInfo = await getRepoForkInfo(slug)
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
                            `[TANGERINE: You have commits on your branch but no pull request has been created. ` +
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

                // Detect PR URL from Bash tool results (e.g. `gh pr create` output)
                if (event.toolResult && !getTaskState(taskId).prUrlSaved) {
                  const prUrl = extractPrUrl(event.toolResult)
                  if (prUrl) trySavePrUrl(db, taskId, prUrl, "tool")
                }
                break
              }
              case "thinking": {
                // Persist thinking to chat and emit via WebSocket
                emitTaskEvent(taskId, {
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
              case "usage": {
                // Track cumulative totals in task state and persist to DB.
                // All providers: add incoming values to cumulative total.
                // For Codex (cumulative=true): session totals restart from zero on
                // thread/start fallback, so we still add to preserve cross-session totals.
                const state = getTaskState(taskId)
                if (event.inputTokens != null) state.cumulativeInputTokens += event.inputTokens
                if (event.outputTokens != null) state.cumulativeOutputTokens += event.outputTokens
                const updates: Record<string, number> = {
                  input_tokens: state.cumulativeInputTokens,
                  output_tokens: state.cumulativeOutputTokens,
                }
                Effect.runPromise(
                  updateTask(db, taskId, updates, { skipUpdatedAt: true }).pipe(
                    Effect.catchAll(() => Effect.void)
                  )
                )
                emitTaskEvent(taskId, {
                  event: "usage",
                  inputTokens: state.cumulativeInputTokens,
                  outputTokens: state.cumulativeOutputTokens,
                  contextTokens: event.contextTokens ?? 0,
                })
                break
              }
              case "error": {
                log.error("Agent event error", { taskId, message: event.message })
                getTaskState(taskId).lastError = event.message
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
        createTask: ({ images, source, ...rest }) =>
          taskManager.createTask(tmDeps, { ...rest, source: source as taskManager.TaskSource }).pipe(
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
              from_task_id: fromTaskId ?? null,
            }).pipe(
              Effect.catchAll(() => Effect.void)
            )

            // Broadcast user message to all WS clients subscribed to this task
            // so that other browser windows see it in real time.
            emitTaskEvent(taskId, {
              role: "user",
              content: text,
              timestamp: new Date().toISOString(),
              images: imageFilenames,
            })

            // Prepend system notes to the first prompt for a task
            let promptText = text
            if (!getTaskState(taskId).firstPromptSent) {
              getTaskState(taskId).firstPromptSent = true
              const task = yield* getTask(db, taskId).pipe(Effect.catchAll(() => Effect.succeed(null)))

              const projConfig = task?.project_id ? getProjectConfig(config.config, task.project_id) : undefined
              const notes = buildSystemNotes(taskId, {
                setupCommand: projConfig?.setup,
                taskType: task?.type ?? undefined,
                prMode: projConfig?.prMode,
                customSystemPrompt: resolveCustomSystemPrompt(projConfig, task?.type),
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
                  return Effect.succeed(false)
                }),
              )
              if (sent) return
            } else if (handle && !handleAlive) {
              log.warn("Agent handle exists but process is dead, removing stale handle", { taskId })
              agentHandles.delete(taskId)
            }

            // Agent not reachable — either suspended (idle timeout) or crashed.
            // Restart the agent and queue the prompt for delivery once ready.
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
            yield* enqueuePrompt(taskId, promptText, images)
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
          getTaskState(taskId).suspended = true

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
            Effect.tap(() => clearQueue(taskId)),
            Effect.tap(() => Effect.sync(() => {
              clearTaskState(taskId)
              agentHandles.delete(taskId)
            })),
            Effect.mapError((e) => ({ _tag: e._tag, message: e.message }))
          ),
        ensureOrchestrator: (projectId, provider, model, reasoningEffort) =>
          taskManager.ensureOrchestrator(tmDeps, projectId, provider, model, reasoningEffort).pipe(
            Effect.mapError((e) => ({ _tag: "TaskError" as const, message: e.message }))
          ),
        startTask: (taskId) =>
          taskManager.startTask(tmDeps, taskId).pipe(
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
      agentFactories: factories,
      systemCapabilities,
    }

    const { app, websocket } = createApp(deps)
    const port = Number(process.env.PORT ?? DEFAULT_API_PORT)

    log.info("Server starting", { port })

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
        if (!handle) return false

        // Prefer session-level health check (covers SSE connectivity for OpenCode)
        if (handle.isAlive) return handle.isAlive()

        // Fallback to PID check for handles without isAlive
        const pid = (handle as { __pid?: number }).__pid
        if (!pid) return false
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }),
      restartAgent: (task) => {
        // Per-task lock: skip if a reconnect is already in progress for this task.
        // Health monitor and resumeOrphanedTasks can race — without this, both spawn
        // a Claude process and only the second handle is tracked, leaving the first orphaned.
        const restartState = getTaskState(task.id)
        if (restartState.reconnecting) {
          log.info("Reconnect already in progress, skipping duplicate", { taskId: task.id })
          return Effect.void
        }
        const provider = task.provider ?? "opencode"
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
        agentHandles.delete(taskId)
        return handle.shutdown().pipe(Effect.catchAll(() => Effect.void))
      },
      persistSuspended: (taskId, suspended) =>
        updateTask(db, taskId, { suspended: suspended ? 1 : 0 }).pipe(Effect.asVoid, Effect.catchAll(() => Effect.void)),
      getLastAgentError: (taskId) => getTaskState(taskId).lastError,
      isAgentWorking: (taskId) => getAgentWorkingState(taskId) === "working",
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
            return meta.status === "running" ? row.timestamp : null
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
        return handle.abort().pipe(Effect.catchAll(() => Effect.void))
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
      cleanupDeps,
    }
    await Effect.runPromise(startHealthMonitor(healthDeps))
    log.info("Health monitor started")

    // Start scheduler for cron-based task spawning (every 60s)
    const schedulerDeps: SchedulerDeps = {
      getDueCrons: () => getDueCrons(db),
      hasActiveCronTask: (cronId) => dbHasActiveCronTask(db, cronId),
      createWorkerFromCron: (cron) => {
        const defaults = cron.task_defaults ? JSON.parse(cron.task_defaults) as Record<string, string> : {}
        return taskManager.createTask(tmDeps, {
          source: "cron",
          sourceId: `cron:${cron.id}`,
          projectId: cron.project_id,
          title: cron.title,
          type: "worker",
          description: cron.description ?? undefined,
          provider: defaults.provider ?? undefined,
          model: defaults.model ?? undefined,
          reasoningEffort: defaults.reasoningEffort ?? undefined,
          branch: defaults.branch ?? undefined,
        })
      },
      updateCron: (cronId, updates) => updateCron(db, cronId, updates) as Effect.Effect<CronRow | null, Error>,
    }
    const scheduler = startScheduler(schedulerDeps)
    log.info("Scheduler started")

    const shutdown = async (signal: string) => {
      log.info("Shutdown signal received", { signal })
      scheduler.stop()
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
