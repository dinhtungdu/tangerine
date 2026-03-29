// CLI entrypoint: loads config, initializes subsystems, starts the server.
// v1: No VM management. Server runs locally. Agents spawn as local processes.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { loadConfig, getProjectConfig, getRepoDir, TANGERINE_HOME, readRawConfig, writeRawConfig, isTestMode } from "../config"
import { getDb } from "../db/index"
import { createTask as dbCreateTask, getTask, listTasks, updateTask, insertSessionLog, markTaskResult } from "../db/queries"
import { logActivity, cleanupActivities } from "../activity"
import type { TaskRow } from "../db/types"
import { createApp } from "../api/app"
import type { AppDeps } from "../api/app"
import { DEFAULT_API_PORT } from "@tangerine/shared"
import * as taskManager from "../tasks/manager"
import type { TaskManagerDeps } from "../tasks/manager"
import { onTaskEvent, onStatusChange, emitTaskEvent, setAgentWorkingState } from "../tasks/events"
import { cleanupSession } from "../tasks/cleanup"
import type { CleanupDeps } from "../tasks/cleanup"
import { startOrphanCleanup, findOrphans, cleanupOrphans } from "../tasks/orphan-cleanup"
import type { OrphanCleanupDeps } from "../tasks/orphan-cleanup"
import { startHealthMonitor } from "../tasks/health"
import type { HealthCheckDeps } from "../tasks/health"
import { reconnectSessionWithRetry } from "../tasks/retry"
import { AgentError } from "../errors"
import { extractPrUrl, verifyPrBranch, startPrMonitor } from "../tasks/pr-monitor"
import type { PrMonitorDeps } from "../tasks/pr-monitor"
import { initSystemLog, cleanupSystemLogs } from "../system-log"
import { createOpenCodeProvider } from "../agent/opencode-provider"
import { createClaudeCodeProvider } from "../agent/claude-code-provider"
import { createCodexProvider } from "../agent/codex-provider"
import type { AgentHandle } from "../agent/provider"
import { enqueue as enqueuePrompt, drainAll as drainQueuedPrompts } from "../agent/prompt-queue"

const log = createLogger("cli")

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

// In-memory map of taskId -> active AgentHandle (for cleanup and abort)
const agentHandles = new Map<string, AgentHandle>()
// Per-task reconnect lock — prevents the health monitor from spawning a duplicate
// reconnect while one is already in progress. Lock is set by callers before
// starting a reconnect; unlocked by reconnectSessionWithRetry via Effect.ensuring.
const reconnectingTasks = new Set<string>()
// Last error emitted by each agent — used by health monitor to surface real errors
const lastAgentErrors = new Map<string, string>()
// Track which tasks have received their first prompt (for setup note injection)
const firstPromptSent = new Set<string>()
// Track tasks that already have a PR URL saved (avoid redundant DB writes)
const prUrlSaved = new Set<string>()
// Track tasks that have been nudged about missing PR (avoid repeated nudges)
const prNudgeSent = new Set<string>()
// Debounce timers for PR nudge (cancelled if agent goes back to working)
const prNudgeTimers = new Map<string, Timer>()

/** Delay before nudging an idle agent about missing PR (ms) */
const PR_NUDGE_DELAY_MS = 15_000

interface TaskInfo {
  projectId?: string
  setupCommand?: string
}

/** Build system notes prepended to the first prompt for a task. */
function buildSystemNotes(taskId: string, info: TaskInfo): string[] {
  const notes: string[] = []
  notes.push(`[TANGERINE: You are running inside a Tangerine task (task ID: ${taskId}). The Tangerine API is at http://localhost:3456. Load the task-handbook skill (\`/task-handbook\`) for full API reference and common workflows.]`)
  if (info.setupCommand) {
    const prefix = taskId.slice(0, 8)
    notes.push(`[NOTE: Project setup is running in the background (\`${info.setupCommand}\`). Before running builds, tests, or linters, check if setup is done: \`cat /tmp/tangerine-setup-${prefix}.status\` (running/done/failed). Log: \`cat /tmp/tangerine-setup-${prefix}.log\`]`)
  }
  notes.push(`[NOTE: When your work is complete, push your branch and create a pull request. Use \`git push origin HEAD\` then \`gh pr create\`. Do not stop at just committing.]`)
  return notes
}

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
    log.info("Config loaded", { projects: projectNames, home: TANGERINE_HOME, testMode: isTestMode() })

    const db = getDb(flags.dbPath)
    initSystemLog(db)
    cleanupSystemLogs(db)
    cleanupActivities(db)
    log.info("Database initialized")

    // Agent provider factories (local — no SSH deps)
    const openCodeFactory = createOpenCodeProvider()
    const claudeCodeFactory = createClaudeCodeProvider()
    const codexFactory = createCodexProvider()

    // Select factory based on provider type
    const getAgentFactory = (provider: string) =>
      provider === "claude-code" ? claudeCodeFactory
        : provider === "codex" ? codexFactory
        : openCodeFactory

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
        agentFactory: openCodeFactory,
        getTask: (taskId) => getTask(db, taskId),
        updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid),
        logActivity: (taskId, type, event, content, metadata) => logActivity(db, taskId, type, event, content, metadata),
      },
      cleanupDeps,
      retryDeps: {
        updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid),
        cleanupDeps,
        lockReconnect: (taskId) => reconnectingTasks.add(taskId),
        unlockReconnect: (taskId) => reconnectingTasks.delete(taskId),
        onSessionReady: (taskId, session) => {
          // Shut down any existing handle before storing the new one (e.g. model
          // change restarts the agent with a new handle for the same task).
          const existingHandle = agentHandles.get(taskId)
          if (existingHandle && existingHandle !== session.agentHandle) {
            Effect.runPromise(existingHandle.shutdown().pipe(Effect.catchAll(() => Effect.void)))
          }
          agentHandles.set(taskId, session.agentHandle)

          // Drain any prompts queued while the agent was starting
          const sendFn = async (_tid: string, text: string, imgs?: import("../agent/provider").PromptImage[]) => {
            await Effect.runPromise(session.agentHandle.sendPrompt(text, imgs).pipe(Effect.catchAll(() => Effect.void)))
          }
          Effect.runPromise(drainQueuedPrompts(taskId, sendFn))

          // Hydrate in-memory tracking from DB (lost on restart)
          const taskMeta = db.prepare("SELECT pr_url FROM tasks WHERE id = ?").get(taskId) as { pr_url: string | null } | null
          if (taskMeta?.pr_url) {
            prUrlSaved.add(taskId)
            prNudgeSent.add(taskId)
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
          if (hasLogs && hasAssistantResponse && lastLog?.role === "user") {
            // Reconnect after server restart or model change — agent had conversation context.
            const sendReconnectNudge = async () => {
              try {
                // Wait for Claude Code to finish initializing before sending a prompt.
                // Do NOT send abort/SIGINT here — Claude Code is idle after resume and
                // SIGINT terminates an idle process rather than interrupting an in-progress turn,
                // causing an immediate crash-restart loop.
                await new Promise((r) => setTimeout(r, 1500))

                const taskRow = db.prepare(
                  "SELECT title, description FROM tasks WHERE id = ?"
                ).get(taskId) as { title: string; description: string | null } | null

                const originalTask = taskRow?.description || taskRow?.title || ""
                const unansweredUserMsg = lastLog?.role === "user" ? lastLog.content : null

                const nudge = [
                  `[TANGERINE: Server restarted. You are working on: ${originalTask}]`,
                  `[NOTE: When your work is complete, you MUST push your branch and create a pull request. Use \`git push origin HEAD\` then \`gh pr create\`.]`,
                  unansweredUserMsg
                    ? `The last message you had not yet responded to was: ${unansweredUserMsg}\n\nPlease continue.`
                    : "Please continue where you left off.",
                ].join("\n\n")

                await Effect.runPromise(
                  session.agentHandle.sendPrompt(nudge).pipe(Effect.catchAll(() => Effect.void))
                )
              } catch (err) {
                log.error("Failed to send reconnect nudge", { taskId, error: String(err) })
              }
            }
            sendReconnectNudge()
          }
          if (!hasLogs || (hasLogs && !hasAssistantResponse)) {
            // No logs at all (fresh task) or logs exist but agent never responded
            // (e.g. killed by model change before processing prompt). Either way,
            // send the full initial prompt — don't resume a nonexistent conversation.
            const isRetry = !!hasLogs // User message already saved, just re-deliver prompt
            const task = db.prepare("SELECT description, title, project_id FROM tasks WHERE id = ?").get(taskId) as { description: string | null; title: string; project_id: string } | null
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

              loadInitialImages().then(({ images, filenames }) => {
                const projConfig = task?.project_id ? getProjectConfig(config.config, task.project_id) : undefined

                const notes = buildSystemNotes(taskId, {
                  setupCommand: projConfig?.setup,
                })
                firstPromptSent.add(taskId)
                const fullPrompt = notes.join("\n") + "\n\n" + initialPrompt

                Effect.runPromise(
                  session.agentHandle.sendPrompt(fullPrompt, images).pipe(Effect.catchAll(() => Effect.void))
                )

                // Only save to session_logs and emit on first delivery — avoid duplicates on retry
                if (!isRetry) {
                  emitTaskEvent(taskId, {
                    role: "user",
                    content: initialPrompt,
                    timestamp: new Date().toISOString(),
                  })
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
                }
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
                if ((event.role === "assistant" || event.role === "narration") && (event.content || event.images?.length)) {
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

                  if (event.images?.length) {
                    // Save agent-produced images to disk (same pattern as user images)
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
                  if (!prUrlSaved.has(taskId)) {
                    const prUrl = extractPrUrl(event.content)
                    if (prUrl) {
                      const taskBranch = (db.prepare("SELECT branch FROM tasks WHERE id = ?").get(taskId) as { branch: string | null } | null)?.branch
                      Effect.runPromise(
                        verifyPrBranch(prUrl, taskBranch ?? "").pipe(
                          Effect.tap((matches) => Effect.sync(() => {
                            if (!matches) { log.warn("PR branch mismatch, ignoring", { taskId, prUrl, taskBranch }); return }
                            prUrlSaved.add(taskId)
                            Effect.runPromise(updateTask(db, taskId, { pr_url: prUrl }).pipe(Effect.catchAll(() => Effect.void)))
                            Effect.runPromise(logActivity(db, taskId, "lifecycle", "pr.created", `PR created: ${prUrl}`, { prUrl }).pipe(Effect.catchAll(() => Effect.void)))
                            log.info("PR URL detected from message", { taskId, prUrl })
                          }))
                        )
                      )
                    }
                  }
                }
                break
              }
              case "status": {
                if (event.status === "working") {
                  setAgentWorkingState(taskId, "working")
                  emitTaskEvent(taskId, { event: "agent.start" })
                  // Cancel pending PR nudge — agent is still working
                  const pendingTimer = prNudgeTimers.get(taskId)
                  if (pendingTimer) {
                    clearTimeout(pendingTimer)
                    prNudgeTimers.delete(taskId)
                  }
                } else if (event.status === "idle") {
                  setAgentWorkingState(taskId, "idle")
                  emitTaskEvent(taskId, { event: "agent.idle" })

                  // Schedule PR nudge if agent has commits but no PR
                  if (!prUrlSaved.has(taskId) && !prNudgeSent.has(taskId)) {
                    const timer = setTimeout(async () => {
                      prNudgeTimers.delete(taskId)
                      if (prUrlSaved.has(taskId) || prNudgeSent.has(taskId)) return

                      // Check DB for existing pr_url (in-memory set is lost on restart)
                      const task = db.prepare("SELECT project_id, pr_url FROM tasks WHERE id = ?").get(taskId) as { project_id: string; pr_url: string | null } | null
                      if (task?.pr_url) {
                        prUrlSaved.add(taskId)
                        return
                      }
                      const projConfig = task?.project_id ? getProjectConfig(config.config, task.project_id) : undefined

                      const hasCommits = await branchHasCommits(db, taskId, projConfig)
                      if (!hasCommits || prUrlSaved.has(taskId)) return

                      prNudgeSent.add(taskId)
                      const handle = agentHandles.get(taskId)
                      if (handle) {
                        log.info("Nudging agent to create PR", { taskId })
                        Effect.runPromise(
                          handle.sendPrompt(
                            "[TANGERINE: You have commits on your branch but no pull request has been created. " +
                            "Please push your branch and create a PR with `git push origin HEAD` and `gh pr create`. " +
                            "A PR is required for the task to be considered complete.]"
                          ).pipe(Effect.catchAll(() => Effect.void))
                        )
                        Effect.runPromise(
                          logActivity(db, taskId, "system", "pr.nudge", "Agent nudged to create PR").pipe(
                            Effect.catchAll(() => Effect.void)
                          )
                        )
                      }
                    }, PR_NUDGE_DELAY_MS)
                    prNudgeTimers.set(taskId, timer)
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
                if (event.toolResult && !prUrlSaved.has(taskId)) {
                  const prUrl = extractPrUrl(event.toolResult)
                  if (prUrl) {
                    const taskBranch = (db.prepare("SELECT branch FROM tasks WHERE id = ?").get(taskId) as { branch: string | null } | null)?.branch
                    Effect.runPromise(
                      verifyPrBranch(prUrl, taskBranch ?? "").pipe(
                        Effect.tap((matches) => Effect.sync(() => {
                          if (!matches) { log.warn("PR branch mismatch, ignoring", { taskId, prUrl, taskBranch }); return }
                          prUrlSaved.add(taskId)
                          Effect.runPromise(updateTask(db, taskId, { pr_url: prUrl }).pipe(Effect.catchAll(() => Effect.void)))
                          Effect.runPromise(logActivity(db, taskId, "lifecycle", "pr.created", `PR created: ${prUrl}`, { prUrl }).pipe(Effect.catchAll(() => Effect.void)))
                          log.info("PR URL detected from tool result", { taskId, prUrl })
                        }))
                      )
                    )
                  }
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
              case "error": {
                log.error("Agent event error", { taskId, message: event.message })
                lastAgentErrors.set(taskId, event.message)
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

            // Prepend system notes to the first prompt for a task
            let promptText = text
            if (!firstPromptSent.has(taskId)) {
              firstPromptSent.add(taskId)
              const task = yield* getTask(db, taskId).pipe(Effect.catchAll(() => Effect.succeed(null)))

              const projConfig = task?.project_id ? getProjectConfig(config.config, task.project_id) : undefined
              const notes = buildSystemNotes(taskId, {
                setupCommand: projConfig?.setup,
              })

              if (notes.length > 0) {
                promptText = notes.join("\n") + "\n\n" + text
              }
            }

            // Try agent handle first (works for both providers)
            const handle = agentHandles.get(taskId)
            if (handle) {
              yield* handle.sendPrompt(promptText, images)
              return
            }

            // No handle yet — queue for later (preserves images)
            yield* enqueuePrompt(taskId, promptText, images)
          }).pipe(
            Effect.catchAll((e) => {
              log.error("sendPrompt failed", { taskId, error: String(e) })
              emitTaskEvent(taskId, { event: "error", message: `Failed to send prompt: ${e instanceof Error ? e.message : String(e)}` })
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
        ensureOrchestrator: (projectId, provider) =>
          taskManager.ensureOrchestrator(tmDeps, projectId, provider).pipe(
            Effect.mapError((e) => ({ _tag: "TaskError" as const, message: e.message }))
          ),
        startTask: (taskId) =>
          taskManager.startTask(tmDeps, taskId).pipe(
            Effect.mapError((e) => ({ _tag: ("_tag" in e ? e._tag : "TaskError") as string, message: e.message }))
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

    // Start update checker (polls git remote for available updates, does not auto-apply)
    {
      const { startUpdateChecker } = await import("../self-update")
      const projectInfos = config.config.projects.map((p) => ({
        name: p.name,
        repoDir: getRepoDir(config.config, p.name),
        defaultBranch: p.defaultBranch ?? "main",
      }))
      await Effect.runPromise(startUpdateChecker(projectInfos))
    }

    // Start PR status monitor (every 60s)
    const prMonitorDeps: PrMonitorDeps = {
      db,
      listTasks: (filter) => listTasks(db, filter),
      updateTask: (taskId, updates) => updateTask(db, taskId, updates).pipe(Effect.asVoid, Effect.mapError((e) => new Error(String(e)))),
      logActivity: (taskId, type, event, content, metadata) => logActivity(db, taskId, type, event, content, metadata),
      cleanupDeps,
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
        if (reconnectingTasks.has(task.id)) {
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
        reconnectingTasks.add(task.id)
        return reconnectSessionWithRetry(task, projectConfig, lifecycleDeps, tmDeps.retryDeps)
      },
      failTask: (taskId, reason) =>
        updateTask(db, taskId, { status: "failed", error: reason }).pipe(
          Effect.asVoid,
          Effect.mapError((e) => new Error(String(e))),
        ),
      getLastAgentError: (taskId) => lastAgentErrors.get(taskId),
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
