// Session lifecycle: get/create project VM, set up worktree, start agent.
// Each step is logged so failures are diagnosable from taskId alone.

import { Effect } from "effect"
import { createLogger } from "../logger"
import { SessionStartError } from "../errors"
import type { TaskRow } from "../db/types"
import type { ProjectVmRow } from "../vm/project-vm"
import { getHandleMeta } from "../agent/opencode-provider"

const log = createLogger("lifecycle")

export interface SessionInfo {
  vmId: string
  agentHandle: import("../agent/provider").AgentHandle
  agentPort: number | null
  previewPort: number
  branch: string
  worktreePath: string
}

export interface LifecycleDeps {
  getOrCreateVm(projectId: string, imageName: string): Effect.Effect<ProjectVmRow, Error>
  sshExec(host: string, port: number, command: string): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, import("../errors").SshError>
  waitForSsh(host: string, port: number): Effect.Effect<void, import("../errors").SshTimeoutError>
  copyAuthJson(host: string, port: number, authJsonPath: string): Effect.Effect<void, import("../errors").SshError>
  injectCredentials(host: string, port: number, credentials: Record<string, string>): Effect.Effect<void, import("../errors").SshError>
  agentFactory: import("../agent/provider").AgentFactory
  updateTask(taskId: string, updates: Partial<TaskRow>): Effect.Effect<void, Error>
  logActivity(taskId: string, type: "lifecycle" | "system", event: string, content: string, metadata?: Record<string, unknown>): Effect.Effect<unknown, Error>
}

export interface ProjectConfig {
  repo: string
  defaultBranch?: string
  image: string
  setup: string
  preview: { port: number }
}

export interface CredentialConfig {
  opencodeAuthPath: string | null
  claudeOauthToken: string | null
  anthropicApiKey: string | null
  githubToken: string | null
}

export function startSession(
  task: TaskRow,
  config: ProjectConfig,
  creds: CredentialConfig,
  deps: LifecycleDeps,
): Effect.Effect<SessionInfo, SessionStartError> {
  const activity = (event: string, content: string, metadata?: Record<string, unknown>) =>
    deps.logActivity(task.id, "lifecycle", event, content, metadata).pipe(Effect.catchAll(() => Effect.void))

  return Effect.gen(function* () {
    const taskLog = log.child({ taskId: task.id })
    const sessionSpan = taskLog.startOp("session-start")
    const taskPrefix = task.id.slice(0, 8)
    const worktreePath = `/workspace/worktrees/${taskPrefix}`
    const branch = `tangerine/${taskPrefix}`

    // 1. Get or create persistent project VM
    taskLog.info("Getting VM for project", { projectId: task.project_id })
    yield* activity("vm.acquiring", "Getting VM for project")
    const vm = yield* deps.getOrCreateVm(task.project_id, config.image).pipe(
      Effect.tapError((e) => activity("vm.acquire_failed", `VM acquisition failed: ${e.message}`)),
      Effect.mapError((e) => new SessionStartError({
        message: `VM acquisition failed: ${e.message}`,
        taskId: task.id,
        phase: "vm-acquire",
        cause: e,
      }))
    )
    const vmLog = taskLog.child({ vmId: vm.id })
    yield* activity("vm.acquired", `VM ready: ${vm.id}`, { vmId: vm.id, ip: vm.ip, sshPort: vm.ssh_port })

    yield* deps.updateTask(task.id, { vm_id: vm.id, status: "provisioning" }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "db-update",
        cause: e,
      }))
    )

    // 2. Wait for SSH
    const sshSpan = vmLog.startOp("ssh-connect")
    yield* activity("ssh.waiting", `Waiting for SSH on ${vm.ip}:${vm.ssh_port}`)
    yield* deps.waitForSsh(vm.ip!, vm.ssh_port!).pipe(
      Effect.tap(() => Effect.sync(() => sshSpan.end())),
      Effect.tap(() => activity("ssh.ready", "SSH connection established")),
      Effect.tapError((e) => activity("ssh.failed", `SSH failed: ${e.message}`)),
      Effect.tapError((e) => Effect.sync(() => sshSpan.fail(e))),
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "ssh-wait",
        cause: e,
      }))
    )

    // 3. Inject credentials (once per VM, idempotent)
    if (creds.opencodeAuthPath) {
      vmLog.debug("Copying OpenCode auth.json to VM")
      yield* deps.copyAuthJson(vm.ip!, vm.ssh_port!, creds.opencodeAuthPath).pipe(
        Effect.mapError((e) => new SessionStartError({
          message: `auth.json copy failed: ${e.message}`,
          taskId: task.id,
          phase: "inject-creds",
          cause: e,
        }))
      )
    }

    // Claude Code auth: inject OAuth token via env var so `claude` CLI picks it up
    const envCreds: Record<string, string> = {}
    if (creds.githubToken) {
      envCreds.GITHUB_TOKEN = creds.githubToken
      envCreds.GH_TOKEN = creds.githubToken
    }
    if (creds.anthropicApiKey) {
      envCreds.ANTHROPIC_API_KEY = creds.anthropicApiKey
    }
    if (creds.claudeOauthToken) {
      envCreds.CLAUDE_CODE_OAUTH_TOKEN = creds.claudeOauthToken
    }
    if (Object.keys(envCreds).length > 0) {
      yield* deps.injectCredentials(vm.ip!, vm.ssh_port!, envCreds).pipe(
        Effect.mapError((e) => new SessionStartError({
          message: `Credential injection failed: ${e.message}`,
          taskId: task.id,
          phase: "inject-creds",
          cause: e,
        }))
      )
    }

    // 4. Clone or fetch the repository
    yield* deps.sshExec(vm.ip!, vm.ssh_port!, "mkdir -p /workspace/worktrees").pipe(
      Effect.catchAll(() => Effect.void),
    )

    const defaultBranch = config.defaultBranch ?? "main"
    const cloneSpan = vmLog.startOp("clone-repo", { repo: task.repo_url })
    yield* activity("repo.cloning", `Setting up ${task.repo_url}`)
    yield* deps.sshExec(
      vm.ip!,
      vm.ssh_port!,
      `if [ -d /workspace/repo/.git ]; then
        cd /workspace/repo && git fetch origin
      else
        git clone ${task.repo_url} /workspace/repo
      fi`,
    ).pipe(
      Effect.tap(() => activity("repo.cloned", "Repository ready")),
      Effect.tap(() => Effect.sync(() => cloneSpan.end())),
      Effect.tapError((e) => activity("repo.clone_failed", `Clone failed: ${e.message}`)),
      Effect.tapError((e) => Effect.sync(() => cloneSpan.fail(e))),
      Effect.mapError((e) => new SessionStartError({
        message: `Clone failed: ${e.message}`,
        taskId: task.id,
        phase: "clone-repo",
        cause: e,
      }))
    )

    // 5. Create worktree for this task
    yield* activity("worktree.creating", `Creating worktree at ${worktreePath}`)
    yield* deps.sshExec(
      vm.ip!,
      vm.ssh_port!,
      `cd /workspace/repo && git worktree add ${worktreePath} -b ${branch} origin/${defaultBranch}`,
    ).pipe(
      Effect.tap(() => activity("worktree.created", "Worktree ready", { worktreePath, branch })),
      Effect.mapError((e) => new SessionStartError({
        message: `Worktree creation failed: ${e.message}`,
        taskId: task.id,
        phase: "create-worktree",
        cause: e,
      }))
    )
    vmLog.debug("Worktree created", { worktreePath, branch })

    yield* deps.updateTask(task.id, { branch, worktree_path: worktreePath }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "db-update",
        cause: e,
      }))
    )

    // 6. Run setup in worktree directory
    const setupSpan = vmLog.startOp("setup")
    yield* activity("setup.started", `Running setup: ${config.setup}`)
    yield* deps.sshExec(vm.ip!, vm.ssh_port!, `cd ${worktreePath} && ${config.setup}`).pipe(
      Effect.tap(() => activity("setup.completed", "Setup completed")),
      Effect.tap(() => Effect.sync(() => setupSpan.end())),
      Effect.tapError((e) => activity("setup.failed", `Setup failed: ${e.message}`)),
      Effect.tapError((e) => Effect.sync(() => setupSpan.fail(e))),
      Effect.mapError((e) => new SessionStartError({
        message: `Setup failed: ${e.message}`,
        taskId: task.id,
        phase: "setup",
        cause: e,
      }))
    )

    // 7. Start agent in worktree directory
    yield* activity("agent.starting", "Starting agent")
    const agentHandle = yield* deps.agentFactory.start({
      taskId: task.id,
      vmIp: vm.ip!,
      sshPort: vm.ssh_port!,
      workdir: worktreePath,
      title: task.title,
      previewPort: config.preview.port,
      model: task.model ?? undefined,
    })
    vmLog.info("Agent started")

    const meta = getHandleMeta(agentHandle)
    const agentPort = meta?.agentPort ?? null
    const previewPort = meta?.previewPort ?? config.preview.port
    const agentSessionId = meta?.sessionId ?? null

    yield* deps.updateTask(task.id, {
      agent_session_id: agentSessionId,
      agent_port: agentPort,
      preview_port: previewPort,
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
      vmId: vm.id, agentSessionId, agentPort, previewPort, branch, worktreePath,
    })
    vmLog.info("Session ready", { agentSessionId, worktreePath })
    sessionSpan.end({ vmId: vm.id, agentSessionId })

    return {
      vmId: vm.id,
      agentHandle,
      agentPort,
      previewPort,
      branch,
      worktreePath,
    }
  })
}

/**
 * Reconnect to an orphaned running task after server restart.
 * Skips worktree creation and setup — just re-starts the agent process.
 * For Claude Code, uses --resume to continue the existing session.
 */
export function reconnectSession(
  task: TaskRow,
  config: ProjectConfig,
  creds: CredentialConfig,
  deps: LifecycleDeps,
): Effect.Effect<SessionInfo, SessionStartError> {
  const activity = (event: string, content: string, metadata?: Record<string, unknown>) =>
    deps.logActivity(task.id, "lifecycle", event, content, metadata).pipe(Effect.catchAll(() => Effect.void))

  return Effect.gen(function* () {
    const taskLog = log.child({ taskId: task.id })
    taskLog.info("Reconnecting orphaned task")
    yield* activity("session.reconnecting", "Reconnecting after server restart")

    const worktreePath = task.worktree_path ?? `/workspace/worktrees/${task.id.slice(0, 8)}`
    const branch = task.branch ?? `tangerine/${task.id.slice(0, 8)}`

    // 1. Get existing VM (must already exist for a running task)
    const vm = yield* deps.getOrCreateVm(task.project_id, config.image).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `VM not available for reconnect: ${e.message}`,
        taskId: task.id,
        phase: "vm-acquire",
        cause: e,
      }))
    )

    // 2. Wait for SSH
    yield* deps.waitForSsh(vm.ip!, vm.ssh_port!).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "ssh-wait",
        cause: e,
      }))
    )

    // 3. Re-inject credentials (idempotent)
    const envCreds: Record<string, string> = {}
    if (creds.githubToken) {
      envCreds.GITHUB_TOKEN = creds.githubToken
      envCreds.GH_TOKEN = creds.githubToken
    }
    if (creds.anthropicApiKey) envCreds.ANTHROPIC_API_KEY = creds.anthropicApiKey
    if (creds.claudeOauthToken) envCreds.CLAUDE_CODE_OAUTH_TOKEN = creds.claudeOauthToken
    if (Object.keys(envCreds).length > 0) {
      yield* deps.injectCredentials(vm.ip!, vm.ssh_port!, envCreds).pipe(
        Effect.mapError((e) => new SessionStartError({
          message: `Credential injection failed: ${e.message}`,
          taskId: task.id,
          phase: "inject-creds",
          cause: e,
        }))
      )
    }

    // 4. Kill any lingering agent process in the worktree
    yield* deps.sshExec(vm.ip!, vm.ssh_port!,
      `pkill -f "claude.*${worktreePath}" 2>/dev/null; pkill -f "opencode.*${worktreePath}" 2>/dev/null; true`
    ).pipe(Effect.catchAll(() => Effect.void))

    // 5. Start agent — resume session if we have a session ID
    yield* activity("agent.reconnecting", "Restarting agent process")
    const agentHandle = yield* deps.agentFactory.start({
      taskId: task.id,
      vmIp: vm.ip!,
      sshPort: vm.ssh_port!,
      workdir: worktreePath,
      title: task.title,
      previewPort: config.preview.port,
      model: task.model ?? undefined,
      resumeSessionId: task.agent_session_id ?? undefined,
    })
    taskLog.info("Agent reconnected")

    const meta = getHandleMeta(agentHandle)
    const agentPort = meta?.agentPort ?? null
    const previewPort = meta?.previewPort ?? config.preview.port
    const agentSessionId = meta?.sessionId ?? task.agent_session_id

    yield* deps.updateTask(task.id, {
      agent_session_id: agentSessionId,
      agent_port: agentPort,
      preview_port: previewPort,
      status: "running",
    }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "db-update",
        cause: e,
      }))
    )

    yield* activity("session.reconnected", "Session reconnected", {
      vmId: vm.id, agentSessionId, agentPort, previewPort,
    })

    return {
      vmId: vm.id,
      agentHandle,
      agentPort,
      previewPort,
      branch,
      worktreePath,
    }
  })
}
