import type { AgentConfigOption, AgentConfig as TangerineAgentConfig } from "@tangerine/shared"
import type { AgentEvent } from "./provider"
import { killProcessTree } from "./process-tree"
import {
  AcpRpcConnection,
  configOptionsFromAcpResponse,
  createAcpEventMapper,
  isPermissionOption,
  isRecord,
  parseAcpCapabilities,
  readStderr,
  selectPermissionOption,
  stringField,
} from "./acp-provider"
import type { AcpAgentCapabilities } from "./acp-provider"

export interface AcpProbeAgentConfig {
  id: string
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface AcpProbeOptions {
  cwd: string
  prompt?: string
  timeoutMs?: number
  settleMs?: number
}

export interface AcpProbeUpdateSample {
  sessionUpdate: string
  contentType?: string
  textLength?: number
  hasMessageId: boolean
}

export interface AcpProbeEventSummary {
  rawUpdateCounts: Record<string, number>
  normalizedEventCounts: Record<string, number>
  samples: AcpProbeUpdateSample[]
}

export interface AcpProbeSessionSummary {
  sessionId: string | null
  configOptions: AgentConfigOption[]
  configOptionCategories: string[]
  hasLegacyModels: boolean
  hasLegacyModes: boolean
}

export interface AcpProbeResult {
  agentId: string
  name: string
  command: string
  ok: boolean
  initialized: boolean
  sessionStarted: boolean
  promptRan: boolean
  timedOut: boolean
  capabilities?: AcpAgentCapabilities
  agentInfo?: Record<string, unknown>
  authMethods: string[]
  session?: AcpProbeSessionSummary
  events: AcpProbeEventSummary
  error?: string
  stderr?: string
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000
const DEFAULT_SETTLE_MS = 100
const MAX_UPDATE_SAMPLES = 20

export async function probeAcpAgents(
  agents: AcpProbeAgentConfig[],
  options: AcpProbeOptions,
): Promise<AcpProbeResult[]> {
  const results: AcpProbeResult[] = []
  for (const agent of agents) {
    results.push(await probeAcpAgent(agent, options))
  }
  return results
}

export async function probeAcpAgent(agent: AcpProbeAgentConfig, options: AcpProbeOptions): Promise<AcpProbeResult> {
  const shellCommand = acpShellCommand(agent)
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const stderrChunks: string[] = []
  const rawUpdateCounts: Record<string, number> = {}
  const normalizedEventCounts: Record<string, number> = {}
  const samples: AcpProbeUpdateSample[] = []
  const mapper = createAcpEventMapper()
  let timedOut = false
  let capabilities: AcpAgentCapabilities | undefined
  let agentInfo: Record<string, unknown> | undefined
  let authMethods: string[] = []
  let sessionSummary: AcpProbeSessionSummary | undefined
  let initialized = false
  let sessionStarted = false
  let promptRan = false
  let rpc: AcpRpcConnection | null = null

  const proc = Bun.spawn(["bash", "-lc", shellCommand], {
    cwd: options.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...agent.env },
  })

  const stopTimer = setTimeout(() => {
    timedOut = true
    rpc?.stop()
    killProcessTree(proc.pid, "SIGKILL")
  }, timeoutMs)

  const countEvent = (event: AgentEvent) => {
    normalizedEventCounts[event.kind] = (normalizedEventCounts[event.kind] ?? 0) + 1
  }

  readStderr(proc.stderr as ReadableStream<Uint8Array>, (text) => stderrChunks.push(text))

  try {
    rpc = new AcpRpcConnection({
      stdout: proc.stdout as ReadableStream<Uint8Array>,
      write: (line) => {
        proc.stdin.write(line)
        proc.stdin.flush()
      },
      onNotification: (_method, params) => {
        if (!isRecord(params) || !isRecord(params.update)) return
        const update = params.update
        const sessionUpdate = stringField(update, "sessionUpdate")
        if (!sessionUpdate) return
        rawUpdateCounts[sessionUpdate] = (rawUpdateCounts[sessionUpdate] ?? 0) + 1
        if (samples.length < MAX_UPDATE_SAMPLES) samples.push(summarizeUpdate(update, sessionUpdate))
        for (const event of mapper.mapSessionUpdate(update)) countEvent(event)
      },
      onRequest: async (method, params) => handleProbeClientRequest(method, params),
      onError: () => undefined,
      onEnd: () => undefined,
    })

    const initResult = await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "tangerine-probe", title: "Tangerine Probe", version: "0.0.8" },
    })
    initialized = true
    capabilities = parseAcpCapabilities(initResult)
    agentInfo = isRecord(initResult) && isRecord(initResult.agentInfo) ? initResult.agentInfo : undefined
    authMethods = summarizeAuthMethods(isRecord(initResult) ? initResult.authMethods : undefined)

    const sessionResult = await rpc.request("session/new", { cwd: options.cwd, mcpServers: [] })
    sessionStarted = true
    const sessionId = isRecord(sessionResult) ? stringField(sessionResult, "sessionId") ?? null : null
    sessionSummary = summarizeSessionResult(sessionResult, sessionId)
    await sleep(settleMs)

    if (options.prompt && sessionId) {
      await rpc.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: options.prompt }],
      })
      promptRan = true
      for (const event of mapper.flushThoughtMessage()) countEvent(event)
      for (const event of mapper.flushAssistantMessage()) countEvent(event)
    }

    await closeProbeSession(rpc, sessionId, capabilities)

    return {
      agentId: agent.id,
      name: agent.name,
      command: shellCommand,
      ok: true,
      initialized,
      sessionStarted,
      promptRan,
      timedOut,
      ...(capabilities ? { capabilities } : {}),
      ...(agentInfo ? { agentInfo } : {}),
      authMethods,
      ...(sessionSummary ? { session: sessionSummary } : {}),
      events: { rawUpdateCounts, normalizedEventCounts, samples },
      ...(stderrChunks.length > 0 ? { stderr: stderrChunks.join("\n") } : {}),
    }
  } catch (error) {
    return {
      agentId: agent.id,
      name: agent.name,
      command: shellCommand,
      ok: false,
      initialized,
      sessionStarted,
      promptRan,
      timedOut,
      ...(capabilities ? { capabilities } : {}),
      ...(agentInfo ? { agentInfo } : {}),
      authMethods,
      ...(sessionSummary ? { session: sessionSummary } : {}),
      events: { rawUpdateCounts, normalizedEventCounts, samples },
      error: error instanceof Error ? error.message : String(error),
      ...(stderrChunks.length > 0 ? { stderr: stderrChunks.join("\n") } : {}),
    }
  } finally {
    clearTimeout(stopTimer)
    rpc?.stop()
    try {
      proc.stdin.end()
    } catch {
      // stdin may already be closed.
    }
    const exited = proc.exited.then(() => undefined, () => undefined)
    killProcessTree(proc.pid, "SIGTERM")
    await Promise.race([exited, sleep(500)])
    killProcessTree(proc.pid, "SIGKILL")
    await Promise.race([exited, sleep(500)])
  }
}

export function acpShellCommand(agent: AcpProbeAgentConfig | TangerineAgentConfig): string {
  return [agent.command, ...(agent.args ?? [])].join(" ").trim()
}

function summarizeSessionResult(value: unknown, sessionId: string | null): AcpProbeSessionSummary {
  const configOptions = configOptionsFromAcpResponse(value) ?? []
  return {
    sessionId,
    configOptions,
    configOptionCategories: configOptions.map((option) => option.category ?? option.id),
    hasLegacyModels: isRecord(value) && isRecord(value.models),
    hasLegacyModes: isRecord(value) && isRecord(value.modes),
  }
}

function summarizeAuthMethods(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): string[] => {
    if (!isRecord(entry)) return []
    const id = stringField(entry, "id")
    const name = stringField(entry, "name")
    if (id && name) return [`${id}:${name}`]
    return id ?? name ? [id ?? name ?? ""] : []
  })
}

function summarizeUpdate(update: Record<string, unknown>, sessionUpdate: string): AcpProbeUpdateSample {
  const content = update.content
  return {
    sessionUpdate,
    ...(isRecord(content) && stringField(content, "type") ? { contentType: stringField(content, "type") } : {}),
    ...(isRecord(content) && typeof content.text === "string" ? { textLength: content.text.length } : {}),
    hasMessageId: typeof update.messageId === "string",
  }
}

async function handleProbeClientRequest(method: string, params: unknown): Promise<unknown> {
  if (method === "session/request_permission") {
    const options = isRecord(params) && Array.isArray(params.options)
      ? params.options.filter(isPermissionOption)
      : []
    const optionId = selectPermissionOption(options)
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } }
  }
  if (method === "fs/read_text_file") return { content: "" }
  if (method === "fs/write_text_file") return {}
  throw new Error(`Unsupported ACP client request during probe: ${method}`)
}

async function closeProbeSession(
  rpc: AcpRpcConnection,
  sessionId: string | null,
  capabilities: AcpAgentCapabilities | undefined,
): Promise<void> {
  if (!sessionId) return
  if (capabilities?.close) {
    await rpc.request("session/close", { sessionId }).catch(() => undefined)
    return
  }
  rpc.notify("session/cancel", { sessionId })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
