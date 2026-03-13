// Session lifecycle: provision VM, clone repo, start OpenCode, establish tunnels.
// Each step is logged so an AI agent can reconstruct failures from taskId alone.

import { Effect } from "effect"
import { createLogger, truncate } from "../logger"
import { SessionStartError } from "../errors"
import type { TaskRow, VmRow } from "../db/types"
import type { SessionTunnel } from "../vm/tunnel"

const log = createLogger("lifecycle")

export interface SessionInfo {
  vmId: string
  opencodeSessionId: string
  opencodePort: number
  previewPort: number
  branch: string
}

export interface LifecycleDeps {
  acquireVm(taskId: string): Effect.Effect<VmRow, import("../errors").PoolExhaustedError | import("../errors").ProviderError | Error>
  sshExec(host: string, port: number, command: string): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, import("../errors").SshError>
  waitForSsh(host: string, port: number): Effect.Effect<void, import("../errors").SshTimeoutError>
  copyAuthJson(host: string, port: number, authJsonPath: string): Effect.Effect<void, import("../errors").SshError>
  injectCredentials(host: string, port: number, credentials: Record<string, string>): Effect.Effect<void, import("../errors").SshError>
  createTunnel(vmIp: string, sshPort: number, ports: { opencodeVmPort: number; previewVmPort: number }): Effect.Effect<SessionTunnel, import("../errors").TunnelError>
  createOpencodeSession(opencodePort: number, title: string): Effect.Effect<string, import("../errors").AgentError>
  waitForHealth(opencodePort: number): Effect.Effect<void, import("../errors").HealthCheckError>
  updateTask(taskId: string, updates: Partial<TaskRow>): Effect.Effect<void, Error>
}

export interface ProjectConfig {
  setup: string
  preview: { port: number }
}

export interface CredentialConfig {
  opencodeAuthPath: string | null
  anthropicApiKey: string | null
  githubToken: string | null
}

export function startSession(
  task: TaskRow,
  config: ProjectConfig,
  creds: CredentialConfig,
  deps: LifecycleDeps,
): Effect.Effect<SessionInfo, SessionStartError> {
  return Effect.gen(function* () {
    const taskLog = log.child({ taskId: task.id })
    const sessionSpan = taskLog.startOp("session-start")

    // Acquire a VM from the warm pool (or provision a new one)
    taskLog.info("Acquiring VM")
    const vm = yield* deps.acquireVm(task.id).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `VM acquisition failed: ${e.message}`,
        taskId: task.id,
        phase: "vm-acquire",
        cause: e,
      }))
    )
    const vmLog = taskLog.child({ vmId: vm.id })

    yield* deps.updateTask(task.id, { vm_id: vm.id, status: "provisioning" }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "db-update",
        cause: e,
      }))
    )

    // Wait for SSH to become available
    const sshSpan = vmLog.startOp("ssh-connect")
    yield* deps.waitForSsh(vm.ip!, vm.ssh_port!).pipe(
      Effect.tap(() => Effect.sync(() => sshSpan.end())),
      Effect.tapError((e) => Effect.sync(() => sshSpan.fail(e))),
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "ssh-wait",
        cause: e,
      }))
    )

    // Copy OpenCode auth.json to VM (inherits host's LLM credentials — API keys or OAuth)
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

    // Inject environment credentials (GitHub token, fallback API key if no auth.json)
    vmLog.debug("Injecting credentials")
    const envCreds: Record<string, string> = {}
    if (creds.githubToken) {
      envCreds.GITHUB_TOKEN = creds.githubToken
      envCreds.GH_TOKEN = creds.githubToken
    }
    if (!creds.opencodeAuthPath && creds.anthropicApiKey) {
      envCreds.ANTHROPIC_API_KEY = creds.anthropicApiKey
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
    vmLog.debug("Credentials injected")

    // Clone the repository
    const cloneSpan = vmLog.startOp("clone-repo", { repo: task.repo_url })
    yield* deps.sshExec(
      vm.ip!,
      vm.ssh_port!,
      `git clone ${task.repo_url} /workspace/repo`,
    ).pipe(
      Effect.tap(() => Effect.sync(() => cloneSpan.end({ repo: task.repo_url }))),
      Effect.tapError((e) => Effect.sync(() => cloneSpan.fail(e, { repo: task.repo_url }))),
      Effect.mapError((e) => new SessionStartError({
        message: `Clone failed: ${e.message}`,
        taskId: task.id,
        phase: "clone-repo",
        cause: e,
      }))
    )

    // Create a working branch for this task
    const branch = `tangerine/${task.id.slice(0, 8)}`
    yield* deps.sshExec(
      vm.ip!,
      vm.ssh_port!,
      `cd /workspace/repo && git checkout -b ${branch}`,
    ).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `Branch creation failed: ${e.message}`,
        taskId: task.id,
        phase: "create-branch",
        cause: e,
      }))
    )
    vmLog.debug("Branch created", { branch })

    yield* deps.updateTask(task.id, { branch }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "db-update",
        cause: e,
      }))
    )

    // Run project-specific setup
    const setupSpan = vmLog.startOp("setup")
    yield* deps.sshExec(vm.ip!, vm.ssh_port!, `cd /workspace/repo && ${config.setup}`).pipe(
      Effect.tap(() => Effect.sync(() => setupSpan.end())),
      Effect.tapError((e) => Effect.sync(() => setupSpan.fail(e))),
      Effect.mapError((e) => new SessionStartError({
        message: `Setup failed: ${e.message}`,
        taskId: task.id,
        phase: "setup",
        cause: e,
      }))
    )

    // Start OpenCode server inside the VM
    yield* deps.sshExec(
      vm.ip!,
      vm.ssh_port!,
      `cd /workspace/repo && opencode serve --port 4096 --hostname 0.0.0.0 &`,
    ).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `OpenCode start failed: ${e.message}`,
        taskId: task.id,
        phase: "start-opencode",
        cause: e,
      }))
    )
    vmLog.info("OpenCode started")

    // Establish SSH tunnels for OpenCode API and preview
    const tunnel = yield* deps.createTunnel(vm.ip!, vm.ssh_port!, {
      opencodeVmPort: 4096,
      previewVmPort: config.preview.port,
    }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `Tunnel creation failed: ${e.message}`,
        taskId: task.id,
        phase: "create-tunnel",
        cause: e,
      }))
    )
    vmLog.info("Tunnel established", {
      opencodePort: tunnel.opencodePort,
      previewPort: tunnel.previewPort,
    })

    yield* deps.updateTask(task.id, {
      opencode_port: tunnel.opencodePort,
      preview_port: tunnel.previewPort,
    }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: e.message,
        taskId: task.id,
        phase: "db-update",
        cause: e,
      }))
    )

    // Wait for OpenCode to become healthy before creating a session
    const healthSpan = vmLog.startOp("opencode-health-wait")
    yield* deps.waitForHealth(tunnel.opencodePort).pipe(
      Effect.tap(() => Effect.sync(() => healthSpan.end())),
      Effect.tapError((e) => Effect.sync(() => healthSpan.fail(e))),
      Effect.mapError((e) => new SessionStartError({
        message: `Health check failed: ${e.message}`,
        taskId: task.id,
        phase: "health-check",
        cause: e,
      }))
    )

    // Create an OpenCode session for this task
    const opencodeSessionId = yield* deps.createOpencodeSession(
      tunnel.opencodePort,
      task.title,
    ).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `Session creation failed: ${e.message}`,
        taskId: task.id,
        phase: "create-session",
        cause: e,
      }))
    )

    yield* deps.updateTask(task.id, {
      opencode_session_id: opencodeSessionId,
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

    vmLog.info("Session ready", { opencodeSessionId })
    sessionSpan.end({ vmId: vm.id, opencodeSessionId })

    return {
      vmId: vm.id,
      opencodeSessionId,
      opencodePort: tunnel.opencodePort,
      previewPort: tunnel.previewPort,
      branch,
    }
  })
}
