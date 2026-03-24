// Session lifecycle: get/create project VM, set up worktree, start agent.
// Each step is logged so failures are diagnosable from taskId alone.

import { Effect } from "effect"
import type { Database } from "bun:sqlite"
import { createLogger } from "../logger"
import { VM_USER } from "../config"
import { SessionStartError } from "../errors"
import type { TaskRow } from "../db/types"
import type { ProjectVmRow } from "../vm/project-vm"
import type { ProxyTunnel } from "../vm/tunnel"
import { allocatePort } from "../vm/tunnel"
import { getHandleMeta } from "../agent/opencode-provider"
import { initPool, acquireSlot } from "./worktree-pool"

const log = createLogger("lifecycle")

export interface SessionInfo {
  vmId: string
  agentHandle: import("../agent/provider").AgentHandle
  agentPort: number | null
  previewPort: number
  branch: string
  worktreePath: string
  proxyTunnel: ProxyTunnel | null
  apiTunnel: ProxyTunnel | null
}

export interface LifecycleDeps {
  db: Database
  getOrCreateVm(projectId: string, imageName: string, onProvision?: (ip: string, sshPort: number) => Effect.Effect<void, Error>): Effect.Effect<ProjectVmRow, Error>
  sshExec(host: string, port: number, command: string): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, import("../errors").SshError>
  waitForSsh(host: string, port: number): Effect.Effect<void, import("../errors").SshTimeoutError>
  copyAuthJson(host: string, port: number, authJsonPath: string): Effect.Effect<void, import("../errors").SshError>
  injectCredentials(host: string, port: number, credentials: Record<string, string>): Effect.Effect<void, import("../errors").SshError>
  createProxyTunnel(opts: { vmIp: string; sshPort: number; localPort: number }): Effect.Effect<ProxyTunnel, import("../errors").TunnelError>
  agentFactory: import("../agent/provider").AgentFactory
  getTask(taskId: string): Effect.Effect<{ status: string } | null, Error>
  updateTask(taskId: string, updates: Partial<TaskRow>): Effect.Effect<void, Error>
  logActivity(taskId: string, type: "lifecycle" | "system", event: string, content: string, metadata?: Record<string, unknown>): Effect.Effect<unknown, Error>
}

export interface ProjectConfig {
  repo: string
  defaultBranch?: string
  image: string
  setup: string
  previewCommand?: string
  poolSize?: number
}

export interface CredentialConfig {
  opencodeAuthPath: string | null
  claudeOauthToken: string | null
  anthropicApiKey: string | null
  githubToken: string | null
  gheToken: string | null
  ghHost: string
  /** Local SOCKS proxy port for GHE access (e.g. 8080). When set, a reverse SSH tunnel
   *  forwards this port into the VM so git/gh can reach the enterprise host. */
  proxyPort: number | null
  /** Tangerine server port — reverse-tunneled into VM for cross-project task creation */
  serverPort: number
  /** External hostname for preview access (e.g. Tailscale hostname). Default: localhost */
  externalHost: string
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
    // Reuse existing branch name if task was reprovisioned
    const branch = task.branch ?? `tangerine/${taskPrefix}`

    // 1. Get or create persistent project VM
    // On first provision: inject credentials, set up proxy, clone repo
    taskLog.info("Getting VM for project", { projectId: task.project_id })
    yield* activity("vm.acquiring", "Getting VM for project")
    const onProvision = (ip: string, sshPort: number) =>
      Effect.gen(function* () {
        // Inject git credentials for HTTPS cloning
        if (creds.githubToken || creds.gheToken) {
          const credLines: string[] = []
          if (creds.githubToken) credLines.push(`https://x-access-token:${creds.githubToken}@github.com`)
          if (creds.gheToken && creds.ghHost !== "github.com") credLines.push(`https://x-access-token:${creds.gheToken}@${creds.ghHost}`)
          yield* deps.sshExec(ip, sshPort,
            `git config --global credential.helper store && printf '%b\\n' '${credLines.join("\\n")}' > ~/.git-credentials && chmod 600 ~/.git-credentials`
          ).pipe(Effect.catchAll(() => Effect.void))
        }
        // Set up SOCKS proxy + SSH→HTTPS rewrite for GHE
        if (creds.proxyPort && creds.ghHost !== "github.com") {
          const proxyUrl = `socks5://127.0.0.2:${creds.proxyPort}`
          // Start a temporary reverse tunnel for the clone
          const tunnelProc = Bun.spawn([
            "ssh", "-N",
            "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
            "-o", "BatchMode=yes", "-o", "LogLevel=ERROR",
            "-p", String(sshPort),
            "-R", `127.0.0.2:${creds.proxyPort}:127.0.0.1:${creds.proxyPort}`,
            `${VM_USER}@${ip}`,
          ], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
          // Wait for tunnel to establish
          yield* Effect.sleep("2 seconds")
          yield* deps.sshExec(ip, sshPort,
            `git config --global http.https://${creds.ghHost}/.proxy ${proxyUrl} && git config --global url."https://${creds.ghHost}/".insteadOf "git@${creds.ghHost}:"`
          ).pipe(Effect.catchAll(() => Effect.void))
          // Clone repo
          yield* deps.sshExec(ip, sshPort,
            `git clone ${task.repo_url} /workspace/repo`
          ).pipe(Effect.mapError((e) => new Error(`Repo pre-clone failed: ${e.message}`)))
          // Kill temporary tunnel
          try { tunnelProc.kill() } catch { /* already dead */ }
        } else {
          // No proxy needed — clone directly
          yield* deps.sshExec(ip, sshPort,
            `git clone ${task.repo_url} /workspace/repo`
          ).pipe(Effect.mapError((e) => new Error(`Repo pre-clone failed: ${e.message}`)))
        }
      })
    const vm = yield* deps.getOrCreateVm(task.project_id, config.image, onProvision).pipe(
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

    // Inject env vars for LLM providers and GitHub CLI
    const envCreds: Record<string, string> = {}
    if (creds.githubToken) {
      envCreds.GITHUB_TOKEN = creds.githubToken
      envCreds.GH_TOKEN = creds.githubToken
    }
    if (creds.gheToken) {
      envCreds.GH_ENTERPRISE_TOKEN = creds.gheToken
    }
    if (creds.ghHost !== "github.com") {
      envCreds.GH_HOST = creds.ghHost
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

    // Log which credentials were injected
    const injectedKeys = Object.keys(envCreds)
    const llmKeys = injectedKeys.filter((k) => k === "ANTHROPIC_API_KEY" || k === "CLAUDE_CODE_OAUTH_TOKEN")
    if (llmKeys.length > 0) {
      yield* activity("creds.injected", `LLM credentials injected: ${llmKeys.join(", ")}`, { keys: injectedKeys })
    } else if (!creds.opencodeAuthPath) {
      yield* activity("creds.missing", "No LLM credentials available — agent may fail to authenticate")
    }

    // Setup git credential helper for HTTPS remotes (idempotent)
    if (creds.githubToken || creds.gheToken) {
      const credLines: string[] = []
      if (creds.githubToken) {
        credLines.push(`https://x-access-token:${creds.githubToken}@github.com`)
      }
      if (creds.gheToken && creds.ghHost !== "github.com") {
        credLines.push(`https://x-access-token:${creds.gheToken}@${creds.ghHost}`)
      }
      const credFileContent = credLines.join("\\n")
      yield* deps.sshExec(vm.ip!, vm.ssh_port!,
        `git config --global credential.helper store && printf '%b\\n' '${credFileContent}' > ~/.git-credentials && chmod 600 ~/.git-credentials`
      ).pipe(
        Effect.mapError((e) => new SessionStartError({
          message: `Git credential setup failed: ${e.message}`,
          taskId: task.id,
          phase: "inject-creds",
          cause: e,
        }))
      )
    }

    // 3b. Start reverse proxy tunnel for GHE access (if configured)
    let proxyTunnel: ProxyTunnel | null = null
    if (creds.proxyPort && creds.ghHost !== "github.com") {
      yield* activity("proxy.starting", `Starting reverse proxy tunnel on port ${creds.proxyPort}`)
      // Kill stale listeners from previous failed attempts (needs sudo for 127.0.0.2-bound ports)
      yield* deps.sshExec(vm.ip!, vm.ssh_port!,
        `sudo fuser -k -n tcp ${creds.proxyPort} 2>/dev/null; true`
      ).pipe(Effect.catchAll(() => Effect.void))
      proxyTunnel = yield* deps.createProxyTunnel({
        vmIp: vm.ip!,
        sshPort: vm.ssh_port!,
        localPort: creds.proxyPort,
      }).pipe(
        Effect.mapError((e) => new SessionStartError({
          message: `Proxy tunnel failed: ${e.message}`,
          taskId: task.id,
          phase: "proxy-tunnel",
          cause: e,
        }))
      )

      // Rewrite GHE SSH URLs to HTTPS (SSH needs Enclave which the VM doesn't have)
      // HTTPS goes through the SOCKS proxy and uses stored git credentials
      const proxyUrl = `socks5://127.0.0.2:${creds.proxyPort}`
      yield* deps.sshExec(vm.ip!, vm.ssh_port!,
        `git config --global http.https://${creds.ghHost}/.proxy ${proxyUrl} && git config --global url."https://${creds.ghHost}/".insteadOf "git@${creds.ghHost}:"`
      ).pipe(
        Effect.mapError((e) => new SessionStartError({
          message: `Git proxy config failed: ${e.message}`,
          taskId: task.id,
          phase: "proxy-tunnel",
          cause: e,
        }))
      )

      // Inject proxy env vars so gh CLI and other tools can reach GHE
      yield* deps.injectCredentials(vm.ip!, vm.ssh_port!, {
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
      }).pipe(
        Effect.mapError((e) => new SessionStartError({
          message: `Proxy env injection failed: ${e.message}`,
          taskId: task.id,
          phase: "proxy-tunnel",
          cause: e,
        }))
      )
      yield* activity("proxy.ready", "Proxy tunnel established")
    }

    // 3c. Reverse tunnel for Tangerine API (cross-project task creation)
    yield* activity("api-tunnel.starting", `Starting API reverse tunnel on port ${creds.serverPort}`)
    yield* deps.sshExec(vm.ip!, vm.ssh_port!,
      `sudo fuser -k -n tcp ${creds.serverPort} 2>/dev/null; true`
    ).pipe(Effect.catchAll(() => Effect.void))
    const apiTunnel = yield* deps.createProxyTunnel({
      vmIp: vm.ip!,
      sshPort: vm.ssh_port!,
      localPort: creds.serverPort,
    }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `API tunnel failed: ${e.message}`,
        taskId: task.id,
        phase: "api-tunnel",
        cause: e,
      }))
    )

    // 3d. Allocate preview port (tunnel created lazily on first preview access)
    const previewPort = yield* allocatePort().pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `Preview port allocation failed: ${e.message}`,
        taskId: task.id,
        phase: "preview-port",
        cause: e,
      }))
    )

    // Inject task ID, server port, and preview env vars
    yield* deps.injectCredentials(vm.ip!, vm.ssh_port!, {
      TANGERINE_TASK_ID: task.id,
      TANGERINE_SERVER_PORT: String(creds.serverPort),
      TANGERINE_PREVIEW_PORT: String(previewPort),
      TANGERINE_HOST: creds.externalHost,
    }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `API env injection failed: ${e.message}`,
        taskId: task.id,
        phase: "api-tunnel",
        cause: e,
      }))
    )
    yield* activity("api-tunnel.ready", "API reverse tunnel established")

    // 4. Clone or fetch the repository
    const defaultBranch = config.defaultBranch ?? "main"
    const cloneSpan = vmLog.startOp("clone-repo", { repo: task.repo_url })
    yield* activity("repo.cloning", `Setting up ${task.repo_url}`)
    yield* deps.sshExec(
      vm.ip!,
      vm.ssh_port!,
      `if [ -d /workspace/repo/.git ]; then
        cd /workspace/repo && git fetch origin
      else
        rm -rf /workspace/repo
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

    // 5. Init worktree pool (idempotent) and acquire a slot
    yield* initPool(deps.db, vm.id, deps.sshExec, vm.ip!, vm.ssh_port!, config.poolSize).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `Pool init failed: ${e.message}`,
        taskId: task.id,
        phase: "pool-init",
        cause: e,
      }))
    )

    yield* activity("worktree.acquiring", "Acquiring worktree slot")
    const slot = yield* acquireSlot(deps.db, vm.id, task.id, deps.getTask).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `Slot acquisition failed: ${e.message}`,
        taskId: task.id,
        phase: "acquire-slot",
        cause: e,
      }))
    )
    const worktreePath = slot.path

    // Checkout the task branch on the acquired slot
    yield* deps.sshExec(
      vm.ip!,
      vm.ssh_port!,
      `cd ${worktreePath} && if git rev-parse --verify origin/${branch} >/dev/null 2>&1; then
        git fetch origin && git checkout -B ${branch} origin/${branch}
      else
        git fetch origin && git checkout -B ${branch} origin/${defaultBranch}
      fi`,
    ).pipe(
      Effect.tap(() => activity("worktree.ready", "Worktree ready", { worktreePath, branch, slot: slot.id })),
      Effect.mapError((e) => new SessionStartError({
        message: `Branch checkout failed: ${e.message}`,
        taskId: task.id,
        phase: "checkout-branch",
        cause: e,
      }))
    )
    vmLog.debug("Worktree slot acquired", { worktreePath, branch, slotId: slot.id })

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

    // 7. Kill any stale agent processes in this worktree (from previous provisioning)
    yield* deps.sshExec(
      vm.ip!, vm.ssh_port!,
      `pkill -f "claude.*${worktreePath}" 2>/dev/null; pkill -f "opencode.*${worktreePath}" 2>/dev/null; true`,
    ).pipe(Effect.catchAll(() => Effect.void))

    // 8. Start agent in worktree directory
    yield* activity("agent.starting", "Starting agent")
    const agentHandle = yield* deps.agentFactory.start({
      taskId: task.id,
      vmIp: vm.ip!,
      sshPort: vm.ssh_port!,
      workdir: worktreePath,
      title: task.title,
      model: task.model ?? undefined,
      reasoningEffort: task.reasoning_effort ?? undefined,
    })
    vmLog.info("Agent started")

    const meta = getHandleMeta(agentHandle)
    const agentPort = meta?.agentPort ?? null
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
      proxyTunnel,
      apiTunnel,
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
    if (creds.gheToken) envCreds.GH_ENTERPRISE_TOKEN = creds.gheToken
    if (creds.ghHost !== "github.com") envCreds.GH_HOST = creds.ghHost
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

    // Log credential status on reconnect
    const llmKeys = Object.keys(envCreds).filter((k) => k === "ANTHROPIC_API_KEY" || k === "CLAUDE_CODE_OAUTH_TOKEN")
    if (llmKeys.length > 0) {
      yield* activity("creds.injected", `LLM credentials re-injected: ${llmKeys.join(", ")}`)
    } else if (!creds.opencodeAuthPath) {
      yield* activity("creds.missing", "No LLM credentials available — agent may fail to authenticate")
    }

    // Re-setup git credential helper (idempotent)
    if (creds.githubToken || creds.gheToken) {
      const credLines: string[] = []
      if (creds.githubToken) {
        credLines.push(`https://x-access-token:${creds.githubToken}@github.com`)
      }
      if (creds.gheToken && creds.ghHost !== "github.com") {
        credLines.push(`https://x-access-token:${creds.gheToken}@${creds.ghHost}`)
      }
      const credFileContent = credLines.join("\\n")
      yield* deps.sshExec(vm.ip!, vm.ssh_port!,
        `git config --global credential.helper store && printf '%b\\n' '${credFileContent}' > ~/.git-credentials && chmod 600 ~/.git-credentials`
      ).pipe(Effect.catchAll(() => Effect.void))
    }

    // 3b. Re-establish reverse proxy tunnel for GHE access (if configured)
    let proxyTunnel: ProxyTunnel | null = null
    if (creds.proxyPort && creds.ghHost !== "github.com") {
      yield* deps.sshExec(vm.ip!, vm.ssh_port!,
        `sudo fuser -k -n tcp ${creds.proxyPort} 2>/dev/null; true`
      ).pipe(Effect.catchAll(() => Effect.void))
      proxyTunnel = yield* deps.createProxyTunnel({
        vmIp: vm.ip!,
        sshPort: vm.ssh_port!,
        localPort: creds.proxyPort,
      }).pipe(
        Effect.mapError((e) => new SessionStartError({
          message: `Proxy tunnel failed: ${e.message}`,
          taskId: task.id,
          phase: "proxy-tunnel",
          cause: e,
        }))
      )

      const proxyUrl = `socks5://127.0.0.2:${creds.proxyPort}`
      yield* deps.sshExec(vm.ip!, vm.ssh_port!,
        `git config --global http.https://${creds.ghHost}/.proxy ${proxyUrl} && git config --global url."https://${creds.ghHost}/".insteadOf "git@${creds.ghHost}:"`
      ).pipe(Effect.catchAll(() => Effect.void))

      yield* deps.injectCredentials(vm.ip!, vm.ssh_port!, {
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
      }).pipe(Effect.catchAll(() => Effect.void))

      yield* activity("proxy.ready", "Proxy tunnel re-established")
    }

    // 3c. Re-establish API reverse tunnel for cross-project task creation
    yield* deps.sshExec(vm.ip!, vm.ssh_port!,
      `sudo fuser -k -n tcp ${creds.serverPort} 2>/dev/null; true`
    ).pipe(Effect.catchAll(() => Effect.void))
    const apiTunnel = yield* deps.createProxyTunnel({
      vmIp: vm.ip!,
      sshPort: vm.ssh_port!,
      localPort: creds.serverPort,
    }).pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `API tunnel failed: ${e.message}`,
        taskId: task.id,
        phase: "api-tunnel",
        cause: e,
      }))
    )

    // 3d. Re-allocate preview port
    const previewPort = yield* allocatePort().pipe(
      Effect.mapError((e) => new SessionStartError({
        message: `Preview port allocation failed: ${e.message}`,
        taskId: task.id,
        phase: "preview-port",
        cause: e,
      }))
    )

    yield* deps.injectCredentials(vm.ip!, vm.ssh_port!, {
      TANGERINE_TASK_ID: task.id,
      TANGERINE_SERVER_PORT: String(creds.serverPort),
      TANGERINE_PREVIEW_PORT: String(previewPort),
      TANGERINE_HOST: creds.externalHost,
    }).pipe(Effect.catchAll(() => Effect.void))

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
      model: task.model ?? undefined,
      reasoningEffort: task.reasoning_effort ?? undefined,
      resumeSessionId: task.agent_session_id ?? undefined,
    })
    taskLog.info("Agent reconnected")

    const meta = getHandleMeta(agentHandle)
    const agentPort = meta?.agentPort ?? null
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
      proxyTunnel,
      apiTunnel,
    }
  })
}
