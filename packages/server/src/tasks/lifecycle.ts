// Session lifecycle: fetch repo, set up worktree, start agent locally.
// v1: Tangerine runs inside the VM. No SSH, no tunnels, no VM management.

import { Effect, Duration } from "effect"
import { resolve } from "node:path"
import type { Database } from "bun:sqlite"
import { createLogger } from "../logger"
import { SessionStartError } from "../errors"
import { getHandleMeta as getOpenCodeHandleMeta } from "../agent/opencode-provider"
import { getRepoDir, resolveWorkspace } from "../config"
import { resolveTaskTypeConfig, type TangerineConfig } from "@tangerine/shared"
import type { TaskRow } from "../db/types"
import { initPool, acquireSlot, acquireOrchestratorSlot } from "./worktree-pool"
import { buildSystemNotes } from "./prompts"
import { killProcessTree } from "../agent/process-tree"
import { resolveGithubSlug, getRepoForkInfo } from "../gh"

const log = createLogger("lifecycle")

// Max time to wait for agentFactory.start() before giving up.
// Covers process spawn + provider handshake (e.g. Codex RPC init).
const AGENT_START_TIMEOUT = Duration.seconds(60)

export interface SessionInfo {
  agentHandle: import("../agent/provider").AgentHandle
  branch: string
  worktreePath: string
  agentSessionId: string | null
  agentPid: number | null
}

export interface LifecycleDeps {
  db: Database
  tangerineConfig: TangerineConfig
  agentFactory: import("../agent/provider").AgentFactory
  getTask(taskId: string): Effect.Effect<{ status: string; branch?: string | null } | null, Error>
  updateTask(taskId: string, updates: Partial<TaskRow>): Effect.Effect<void, Error>
  logActivity(taskId: string, type: "lifecycle" | "system", event: string, content: string, metadata?: Record<string, unknown>): Effect.Effect<unknown, Error>
}

export interface ProjectConfig {
  repo: string
  defaultBranch?: string
  setup: string
  poolSize?: number
  defaultProvider?: string
  archived?: boolean
  prMode?: "ready" | "draft" | "none"
  taskTypes?: import("@tangerine/shared").ProjectConfig["taskTypes"]
}

/** Resolve custom system prompt for a task type from taskTypes config. */
function resolveCustomSystemPrompt(config: ProjectConfig, taskType: string | null | undefined): string | undefined {
  const tt = taskType as "worker" | "orchestrator" | "reviewer" | undefined
  if (!tt) return undefined
  return config.taskTypes?.[tt]?.systemPrompt
}

/** Run a local command via Bun.spawn, return stdout/stderr/exitCode */
function localExec(command: string, cwd?: string): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, Error> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["bash", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (exitCode !== 0) {
        throw new Error(`Command failed (exit ${exitCode}): ${stderr || stdout}`)
      }
      return { stdout, stderr, exitCode }
    },
    catch: (e) => e instanceof Error ? e : new Error(String(e)),
  })
}

export function startSession(
  task: TaskRow,
  config: ProjectConfig,
  deps: LifecycleDeps,
): Effect.Effect<SessionInfo, SessionStartError> {
  const activity = (event: string, content: string, metadata?: Record<string, unknown>) =>
    deps.logActivity(task.id, "lifecycle", event, content, metadata).pipe(Effect.catchAll(() => Effect.void))

  return Effect.gen(function* () {
    const taskLog = log.child({ taskId: task.id })
    const sessionSpan = taskLog.startOp("session-start")
    const taskPrefix = task.id.slice(0, 8)
    const defaultBranch = config.defaultBranch ?? "main"
    const isOrchestrator = task.type === "orchestrator"
    const isRunner = task.type === "runner"
    // Orchestrator stays on the default branch in slot 0.
    // Runner tasks run on the project root without a dedicated worktree.
    // Regular tasks use pre-set branch (from PR/branch input) or generate one.
    // Never work directly on the default branch — git worktrees can't share branches
    // with the main repo, and agents should always work on isolated branches.
    const taskBranch = (isOrchestrator || isRunner) ? defaultBranch : (task.branch === defaultBranch ? null : task.branch)
    const isExistingBranch = !isOrchestrator && !isRunner && !!taskBranch && !taskBranch.startsWith("tangerine/")
    const branch = (isOrchestrator || isRunner) ? defaultBranch : (taskBranch ?? `tangerine/${taskPrefix}`)
    const repoDir = getRepoDir(deps.tangerineConfig, task.project_id)

    const baseBranch = defaultBranch

    yield* deps.updateTask(task.id, { status: "provisioning" }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "db-update",
        cause: e,
      }))
    )

    // 1. Fetch repo
    yield* activity("repo.fetching", `Fetching ${config.repo}`)
    yield* localExec(`cd ${repoDir} && git fetch origin`).pipe(
      Effect.tap(() => activity("repo.fetched", "Repository fetched")),
      Effect.tapError((e) => activity("repo.fetch_failed", `Fetch failed: ${e.message}`)),
      Effect.mapError((e) => new SessionStartError({
        message: `Fetch failed: ${e.message}`,
        taskId: task.id,
        phase: "fetch-repo",
        cause: e,
      }))
    )

    let worktreePath: string

    if (isRunner) {
      // Runner tasks run directly on the project root — no worktree slot, no branch.
      // Reset to default branch so the task doesn't inherit stale state from a previous run.
      worktreePath = resolve(repoDir)
      yield* localExec(
        `cd ${worktreePath} && git checkout ${defaultBranch} 2>/dev/null; git reset --hard origin/${defaultBranch} && git clean -fd`,
      ).pipe(
        Effect.tap(() => activity("worktree.ready", "Runner task using project root", { worktreePath })),
        Effect.mapError((e) => new SessionStartError({
          message: `Project root reset failed: ${e.message}`,
          taskId: task.id,
          phase: "checkout-branch",
          cause: e,
        }))
      )
      taskLog.debug("Runner task using project root", { worktreePath })
    } else {
      // 2. Init worktree pool (idempotent) and acquire a slot
      const exec = (cmd: string) => localExec(cmd, repoDir)
      yield* initPool(deps.db, task.project_id, exec, repoDir, config.poolSize).pipe(
        Effect.mapError((e) => new SessionStartError({
          message: `Pool init failed: ${e.message}`,
          taskId: task.id,
          phase: "pool-init",
          cause: e,
        }))
      )

      yield* activity("worktree.acquiring", isOrchestrator ? "Acquiring orchestrator slot" : "Acquiring worktree slot")
      const slot = yield* (isOrchestrator
        ? acquireOrchestratorSlot(deps.db, task.project_id, task.id, deps.getTask)
        : acquireSlot(deps.db, task.project_id, task.id, deps.getTask, exec, defaultBranch)
      ).pipe(
        Effect.mapError((e) => new SessionStartError({
          message: `Slot acquisition failed: ${e.message}`,
          taskId: task.id,
          phase: "acquire-slot",
          cause: e,
        }))
      )
      yield* activity("worktree.acquired", `Acquired worktree slot`, { slot: slot.id })
      worktreePath = resolve(slot.path)

      if (isOrchestrator) {
        // Orchestrator uses slot 0 (main repo) — fetch, reset to clean default branch state.
        // Previous orchestrator runs may have left uncommitted changes or a different checkout.
        yield* localExec(
          `cd ${worktreePath} && git fetch origin && git checkout ${defaultBranch} 2>/dev/null; git reset --hard origin/${defaultBranch} && git clean -fd`,
        ).pipe(
          Effect.tap(() => activity("worktree.ready", "Orchestrator slot ready", { worktreePath, branch, slot: slot.id })),
          Effect.mapError((e) => new SessionStartError({
            message: `Orchestrator reset failed: ${e.message}`,
            taskId: task.id,
            phase: "checkout-branch",
            cause: e,
          }))
        )
      } else {
        // Checkout the task branch on the acquired slot
        yield* localExec(
          `cd ${worktreePath} && if git rev-parse --verify origin/${branch} >/dev/null 2>&1; then
            git fetch origin && git checkout -B ${branch} origin/${branch}
          else
            git fetch origin && git checkout -B ${branch} origin/${baseBranch}
          fi`,
        ).pipe(
          Effect.tap(() => activity("worktree.ready",
            isExistingBranch ? `Checked out existing branch: ${branch}` : "Worktree ready",
            { worktreePath, branch, slot: slot.id, isExistingBranch })),
          Effect.mapError((e) => new SessionStartError({
            message: `Branch checkout failed: ${e.message}`,
            taskId: task.id,
            phase: "checkout-branch",
            cause: e,
          }))
        )
      }
      taskLog.debug("Worktree slot acquired", { worktreePath, branch, slotId: slot.id })
    }

    yield* deps.updateTask(task.id, { branch: isRunner ? null : branch, worktree_path: worktreePath }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "db-update",
        cause: e,
      }))
    )

    // 3. Run setup in background (non-blocking)
    const setupStatusFile = `/tmp/tangerine-setup-${taskPrefix}.status`
    const setupLogFile = `/tmp/tangerine-setup-${taskPrefix}.log`
    const setupSpan = taskLog.startOp("setup")
    yield* activity("setup.started", `Running setup (background): ${config.setup}`)

    const setupCmd = [
      `echo running > ${setupStatusFile};`,
      `( cd ${worktreePath} && ${config.setup} ) > ${setupLogFile} 2>&1;`,
      `if [ $? -eq 0 ]; then echo done > ${setupStatusFile}; else echo failed > ${setupStatusFile}; fi`,
    ].join(" ")

    // Fire and forget — nohup so it survives if this process dies
    Bun.spawn(["bash", "-c", `nohup bash -c '${setupCmd.replace(/'/g, "'\\''")}' </dev/null >/dev/null 2>&1 &`], {
      cwd: worktreePath,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    })

    // Monitor setup completion in background (for activity log, not blocking)
    yield* Effect.forkDaemon(
      Effect.gen(function* () {
        for (let i = 0; i < 120; i++) {
          yield* Effect.sleep("5 seconds")
          const result = yield* localExec(`cat ${setupStatusFile} 2>/dev/null || echo running`).pipe(
            Effect.catchAll(() => Effect.succeed({ stdout: "running", stderr: "", exitCode: 0 }))
          )
          const status = result.stdout.trim()
          if (status === "done") {
            yield* activity("setup.completed", "Setup completed")
            setupSpan.end()
            return
          }
          if (status === "failed") {
            const logResult = yield* localExec(`tail -20 ${setupLogFile} 2>/dev/null`).pipe(
              Effect.catchAll(() => Effect.succeed({ stdout: "(no log)", stderr: "", exitCode: 0 }))
            )
            yield* activity("setup.failed", `Setup failed (non-blocking): ${logResult.stdout.trim().slice(0, 500)}`)
            setupSpan.fail(new Error("Setup failed"))
            return
          }
        }
        yield* activity("setup.failed", "Setup timed out after 10 minutes")
        setupSpan.fail(new Error("Setup timed out"))
      })
    )

    // 4. Kill any stale agent processes in this worktree
    yield* localExec(
      `pkill -f "claude.*${worktreePath}" 2>/dev/null; true`,
    ).pipe(Effect.catchAll(() => Effect.void))

    // 5. Detect fork upstream for PR targeting
    let upstreamSlug: string | undefined
    if (task.type === "worker" && config.prMode !== "none") {
      const slug = resolveGithubSlug(config.repo)
      if (slug) {
        const forkInfo = yield* Effect.tryPromise({
          try: () => getRepoForkInfo(slug),
          catch: () => ({ isFork: false, parentSlug: null }),
        }).pipe(Effect.catchAll(() => Effect.succeed({ isFork: false, parentSlug: null })))
        if (forkInfo.isFork && forkInfo.parentSlug) {
          upstreamSlug = forkInfo.parentSlug
        }
      }
    }

    // 6. Start agent locally (with timeout to prevent indefinite hangs)
    yield* activity("agent.starting", "Starting agent")
    const systemNotes = buildSystemNotes(task.id, {
      setupCommand: isRunner ? undefined : config.setup,
      taskType: task.type ?? undefined,
      prMode: config.prMode,
      customSystemPrompt: resolveCustomSystemPrompt(config, task.type),
      upstreamSlug,
    })
    const agentHandle = yield* deps.agentFactory.start({
      taskId: task.id,
      workdir: worktreePath,
      title: task.title,
      systemPrompt: systemNotes.length > 0 ? systemNotes.join("\n") : undefined,
      model: task.model ?? undefined,
      reasoningEffort: task.reasoning_effort ?? undefined,
      env: { TANGERINE_TASK_ID: task.id },
    }).pipe(
      Effect.timeoutFail({
        duration: AGENT_START_TIMEOUT,
        onTimeout: () => new SessionStartError({
          message: `Agent failed to start within ${Duration.toSeconds(AGENT_START_TIMEOUT)}s`,
          taskId: task.id,
          phase: "agent-start-timeout",
        }),
      }),
    )
    taskLog.info("Agent started")

    // Extract PID from handle if available
    const { agentPid, agentSessionId } = getAgentRuntimeMeta(agentHandle)

    yield* deps.updateTask(task.id, {
      agent_session_id: agentSessionId,
      agent_pid: agentPid,
      status: "running",
      started_at: new Date().toISOString(),
    }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "db-update",
        cause: e,
      }))
    )

    yield* activity("session.ready", "Session ready", {
      agentPid, agentSessionId, branch, worktreePath,
    })
    taskLog.info("Session ready", { agentPid, agentSessionId, worktreePath })
    sessionSpan.end({ agentPid, agentSessionId })

    return { agentHandle, branch, worktreePath, agentSessionId, agentPid }
  })
}

/**
 * Reconnect to an orphaned running task after server restart.
 * Checks if agent PID is still alive; if dead, restarts with --resume.
 */
export function reconnectSession(
  task: TaskRow,
  config: ProjectConfig,
  deps: LifecycleDeps,
): Effect.Effect<SessionInfo, SessionStartError> {
  const activity = (event: string, content: string, metadata?: Record<string, unknown>) =>
    deps.logActivity(task.id, "lifecycle", event, content, metadata).pipe(Effect.catchAll(() => Effect.void))

  return Effect.gen(function* () {
    const taskLog = log.child({ taskId: task.id })
    taskLog.info("Reconnecting orphaned task")
    yield* activity("session.reconnecting", "Reconnecting after server restart")

    const worktreePath = task.worktree_path ?? `${resolveWorkspace(deps.tangerineConfig)}/${task.project_id}/${task.id.slice(0, 8)}`
    const branch = task.branch ?? `tangerine/${task.id.slice(0, 8)}`

    // 1. Kill any lingering agent processes in the worktree before spawning a new one.
    // Without this, the old process stays alive and fights the new one over the same worktree.
    const existingPid = (task as TaskRow & { agent_pid?: number | null }).agent_pid
    if (existingPid) {
      yield* Effect.sync(() => {
        killProcessTree(existingPid, "SIGTERM")
        taskLog.info("Killed existing agent process tree", { pid: existingPid })
      }).pipe(Effect.catchAll(() => Effect.void))
    }
    yield* localExec(
      `pkill -f "claude.*${worktreePath}" 2>/dev/null; true`,
    ).pipe(Effect.catchAll(() => Effect.void))

    // 2b. Bail out if the task was cancelled or failed while we were preparing.
    // Health monitor restarts run async; a cancel/fail can race with reconnect and
    // we must not overwrite the terminal status with "running".
    const currentState = yield* deps.getTask(task.id).pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (currentState?.status === "cancelled" || currentState?.status === "failed") {
      taskLog.info("Task was cancelled/failed before reconnect completed, aborting reconnect", { status: currentState.status })
      return yield* Effect.fail(new SessionStartError({
        message: `Task ${task.id} is ${currentState.status}, not reconnecting`,
        taskId: task.id,
        phase: "reconnect-guard",
      }))
    }

    // 3. Start agent — resume session if we have a session ID (with timeout)
    yield* activity("agent.reconnecting", "Restarting agent process")
    const project = deps.tangerineConfig.projects.find((p) => p.name === task.project_id)
    const taskType = task.type as "worker" | "orchestrator" | "reviewer" | "runner" | undefined
    const resolved = project && taskType && taskType !== "runner" ? resolveTaskTypeConfig(project, taskType) : undefined

    // Detect fork upstream for PR targeting on reconnect
    let reconnectUpstreamSlug: string | undefined
    if (taskType === "worker" && project?.prMode !== "none" && project?.repo) {
      const slug = resolveGithubSlug(project.repo)
      if (slug) {
        const forkInfo = yield* Effect.tryPromise({
          try: () => getRepoForkInfo(slug),
          catch: () => ({ isFork: false, parentSlug: null }),
        }).pipe(Effect.catchAll(() => Effect.succeed({ isFork: false, parentSlug: null })))
        if (forkInfo.isFork && forkInfo.parentSlug) {
          reconnectUpstreamSlug = forkInfo.parentSlug
        }
      }
    }

    const isRunner = taskType === "runner"
    const systemNotes = buildSystemNotes(task.id, {
      setupCommand: isRunner ? undefined : project?.setup,
      taskType: taskType,
      prMode: project?.prMode,
      customSystemPrompt: resolved?.systemPrompt,
      upstreamSlug: reconnectUpstreamSlug,
    })
    const agentHandle = yield* deps.agentFactory.start({
      taskId: task.id,
      workdir: worktreePath,
      title: task.title,
      systemPrompt: systemNotes.length > 0 ? systemNotes.join("\n") : undefined,
      model: task.model ?? undefined,
      reasoningEffort: task.reasoning_effort ?? undefined,
      resumeSessionId: task.agent_session_id ?? undefined,
    }).pipe(
      Effect.timeoutFail({
        duration: AGENT_START_TIMEOUT,
        onTimeout: () => new SessionStartError({
          message: `Agent failed to reconnect within ${Duration.toSeconds(AGENT_START_TIMEOUT)}s`,
          taskId: task.id,
          phase: "agent-reconnect-timeout",
        }),
      }),
    )
    taskLog.info("Agent reconnected")

    const { agentPid, agentSessionId } = getAgentRuntimeMeta(agentHandle)

    yield* deps.updateTask(task.id, {
      agent_session_id: agentSessionId,
      agent_pid: agentPid,
      status: "running",
    }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "db-update",
        cause: e,
      }))
    )

    yield* activity("session.reconnected", "Session reconnected", { agentPid, agentSessionId })

    return { agentHandle, branch, worktreePath, agentSessionId, agentPid }
  })
}

export function getAgentRuntimeMeta(handle: import("../agent/provider").AgentHandle): { agentPid: number | null; agentSessionId: string | null } {
  const processMeta = handle as { __pid?: number }
  const openCodeMeta = getOpenCodeHandleMeta(handle)
  return {
    agentPid: processMeta.__pid ?? null,
    agentSessionId: openCodeMeta?.sessionId ?? null,
  }
}
