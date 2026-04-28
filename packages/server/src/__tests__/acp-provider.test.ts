import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { AgentEvent } from "../agent/provider"
import {
  AcpRpcConnection,
  buildAcpPromptBlocks,
  createAcpEventMapper,
  createAcpProvider,
  resolveAcpCommand,
  selectPermissionOption,
} from "../agent/acp-provider"

const originalAcpCommand = process.env.TANGERINE_ACP_COMMAND

afterEach(() => {
  if (originalAcpCommand === undefined) delete process.env.TANGERINE_ACP_COMMAND
  else process.env.TANGERINE_ACP_COMMAND = originalAcpCommand
})

describe("resolveAcpCommand", () => {
  test("defaults to acp-agent", () => {
    const command = resolveAcpCommand({})

    expect(command.shellCommand).toBe("acp-agent")
    expect(command.checkCommand).toBe("acp-agent")
  })

  test("uses TANGERINE_ACP_COMMAND and extracts executable for system checks", () => {
    const command = resolveAcpCommand({ TANGERINE_ACP_COMMAND: "codex-acp --model gpt-5" })

    expect(command.shellCommand).toBe("codex-acp --model gpt-5")
    expect(command.checkCommand).toBe("codex-acp")
  })
})

describe("buildAcpPromptBlocks", () => {
  test("builds text-only prompts", () => {
    expect(buildAcpPromptBlocks("hello", [], false)).toEqual([{ type: "text", text: "hello" }])
  })

  test("includes images only when image prompts are supported", () => {
    expect(buildAcpPromptBlocks("look", [{ mediaType: "image/png", data: "abc" }], true)).toEqual([
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/png", data: "abc" },
    ])

    expect(() => buildAcpPromptBlocks("look", [{ mediaType: "image/png", data: "abc" }], false))
      .toThrow("ACP agent does not support image prompts")
  })
})

describe("selectPermissionOption", () => {
  test("prefers allow options for unattended background tasks", () => {
    expect(selectPermissionOption([
      { optionId: "reject", name: "Reject", kind: "reject_once" },
      { optionId: "allow", name: "Allow", kind: "allow_once" },
    ])).toBe("allow")
  })

  test("falls back to first option when no allow option exists", () => {
    expect(selectPermissionOption([
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ])).toBe("reject")
  })
})

describe("createAcpEventMapper", () => {
  test("streams and flushes assistant text", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: "hel" } }))
      .toEqual([{ kind: "message.streaming", content: "hel", messageId: "msg-1" }])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: "lo" } }))
      .toEqual([{ kind: "message.streaming", content: "lo", messageId: "msg-1" }])
    expect(mapper.flushAssistantMessage()).toEqual([{ kind: "message.complete", role: "assistant", content: "hello", messageId: "msg-1" }])
    expect(mapper.flushAssistantMessage()).toEqual([])
  })

  test("streams thought chunks and flushes one complete thought", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thi" } }))
      .toEqual([{ kind: "thinking.streaming", content: "thi", messageId: "thought-1" }])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "nk" } }))
      .toEqual([{ kind: "thinking.streaming", content: "nk", messageId: "thought-1" }])
    expect(mapper.flushThoughtMessage()).toEqual([{ kind: "thinking.complete", content: "think", messageId: "thought-1" }])
    expect(mapper.flushThoughtMessage()).toEqual([])
  })

  test("maps plans, tool calls, and usage updates", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({
      sessionUpdate: "plan",
      entries: [
        { content: "Inspect", priority: "high", status: "in_progress" },
        { content: "Patch", priority: "medium", status: "pending" },
      ],
    })).toEqual([
      { kind: "thinking", content: "Plan:\n- [in_progress/high] Inspect\n- [pending/medium] Patch" },
      { kind: "plan", entries: [
        { content: "Inspect", priority: "high", status: "in_progress" },
        { content: "Patch", priority: "medium", status: "pending" },
      ] },
    ])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read file", status: "pending", rawInput: { path: "/tmp/a.ts" } }))
      .toEqual([{ kind: "tool.start", toolName: "Read file", toolInput: "{\"path\":\"/tmp/a.ts\"}" }])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { ok: true } }))
      .toEqual([{ kind: "tool.end", toolName: "Read file", toolResult: "{\"ok\":true}" }])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "usage_update", used: 123, size: 1000 }))
      .toEqual([{ kind: "usage", contextTokens: 123 }])
    expect(mapper.mapSessionUpdate({
      sessionUpdate: "session_info_update",
      title: "Implement auth",
      updatedAt: "2026-04-27T10:00:00.000Z",
      _meta: { tags: ["auth"] },
    })).toEqual([{ kind: "session.info", title: "Implement auth", updatedAt: "2026-04-27T10:00:00.000Z", metadata: { tags: ["auth"] } }])
  })

  test("maps ACP non-text content blocks", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "resource_link", uri: "file:///tmp/a.ts", name: "a.ts", mimeType: "text/typescript" },
    })).toEqual([{ kind: "content.block", block: { type: "resource_link", uri: "file:///tmp/a.ts", name: "a.ts", mimeType: "text/typescript" } }])
  })

  test("does not render malformed text chunks as content block cards", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text" },
    })).toEqual([])
  })

  test("maps ACP diff and terminal tool content to native content blocks", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      status: "in_progress",
      content: [
        { type: "diff", path: "/repo/src/a.ts", oldText: "old", newText: "new" },
        { type: "terminal", terminalId: "term-1" },
      ],
    })).toEqual([
      { kind: "content.block", block: { type: "diff", path: "/repo/src/a.ts", oldText: "old", newText: "new" } },
      { kind: "content.block", block: { type: "terminal", terminalId: "term-1" } },
    ])
  })

  test("maps config option updates", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({
      sessionUpdate: "config_option_update",
      configOptions: [{
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5",
        options: [{ value: "gpt-5", name: "GPT-5" }],
      }],
    })).toEqual([{ kind: "config.options", options: [{
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gpt-5",
      options: [{ value: "gpt-5", name: "GPT-5" }],
      source: "config_option",
    }] }])
  })
})

describe("AcpRpcConnection", () => {
  test("rejects pending requests when stdout ends", async () => {
    const holder: { close?: () => void } = {}
    const stdout = new ReadableStream<Uint8Array>({
      start(streamController) {
        holder.close = () => streamController.close()
      },
    })
    let ended = false
    const rpc = new AcpRpcConnection({
      stdout,
      write: () => undefined,
      onNotification: () => undefined,
      onRequest: async () => ({}),
      onError: () => undefined,
      onEnd: () => {
        ended = true
      },
    })

    const pending = rpc.request("session/new", {})
    holder.close?.()

    let errorMessage = ""
    try {
      await pending
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toBe("ACP connection ended")
    expect(ended).toBe(true)
    rpc.stop()
  })
})

describe("createAcpProvider", () => {
  test("accepts configured ACP agent metadata", () => {
    const provider = createAcpProvider({ id: "codex", name: "Codex", command: "codex-acp --model gpt-5" })

    expect(provider.metadata.displayName).toBe("Codex")
    expect(provider.metadata.abbreviation).toBe("Codex")
    expect(provider.metadata.cliCommand).toBe("codex-acp")
  })

  test("runs an ACP stdio agent and maps prompt streaming, permissions, tool calls, and usage", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tangerine-acp-provider-"))
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test" }))

    const events: AgentEvent[] = []
    handle.subscribe((event) => events.push(event))

    await Effect.runPromise(handle.sendPrompt("hi", [{ mediaType: "image/png", data: "abc" }]))
    await waitFor(() => events.some((event) => event.kind === "status" && event.status === "idle"))
    await Effect.runPromise(handle.shutdown())

    expect((handle as { __meta?: { sessionId: string } }).__meta?.sessionId).toBe("sess-test")
    expect(events).toContainEqual({ kind: "status", status: "working" })
    expect(events).toContainEqual({ kind: "message.streaming", content: "hello " })
    expect(events).toContainEqual({ kind: "message.streaming", content: "permission:allow" })
    expect(events).toContainEqual({ kind: "tool.start", toolName: "Edit file", toolInput: "{\"path\":\"/tmp/file\"}" })
    expect(events).toContainEqual({
      kind: "permission.decision",
      toolName: "Edit file",
      optionId: "allow",
      optionName: "Allow",
      optionKind: "allow_once",
    })
    expect(events).toContainEqual({ kind: "tool.end", toolName: "Edit file", toolResult: "{\"permission\":\"allow\"}" })
    expect(events).toContainEqual({ kind: "message.complete", role: "assistant", content: "hello permission:allow" })
    expect(events).toContainEqual({ kind: "usage", inputTokens: 10, outputTokens: 5, contextTokens: 15, cumulative: true })
    expect(events).toContainEqual({ kind: "status", status: "idle" })

    rmSync(tempDir, { recursive: true, force: true })
  })

  test("resumes existing ACP sessions when supported", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tangerine-acp-resume-"))
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockResumeAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test", resumeSessionId: "sess-old" }))

    expect((handle as { __meta?: { sessionId: string } }).__meta?.sessionId).toBe("sess-old")

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("loads existing ACP sessions when resume is unavailable", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tangerine-acp-load-"))
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockLoadAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test", resumeSessionId: "sess-old" }))

    expect((handle as { __meta?: { sessionId: string } }).__meta?.sessionId).toBe("sess-old")

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("falls back to fresh ACP sessions when resume and load are unsupported", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tangerine-acp-fresh-"))
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockFreshAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test", resumeSessionId: "sess-old" }))

    expect((handle as { __meta?: { sessionId: string } }).__meta?.sessionId).toBe("sess-new")

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("applies ACP model config options without restarting", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tangerine-acp-config-"))
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockConfigAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test" }))
    const events: Record<string, unknown>[] = []
    handle.subscribe((event) => events.push(event as unknown as Record<string, unknown>))

    await waitFor(() => events.some((event) => event.kind === "config.options"))
    const applied = await Effect.runPromise(handle.updateConfig?.({ model: "gpt-5-large" }) ?? Effect.succeed(false))
    await waitFor(() => events.some((event) => event.kind === "config.options" && Array.isArray(event.options) && event.options.some((option) => typeof option === "object" && option !== null && "currentValue" in option && option.currentValue === "gpt-5-large")))

    expect(applied).toBe(true)
    expect(events).toContainEqual({ kind: "config.options", options: [{
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gpt-5",
      options: [{ value: "gpt-5", name: "GPT-5" }, { value: "gpt-5-large", name: "GPT-5 Large" }],
      source: "config_option",
    }] })
    expect(events).toContainEqual({ kind: "config.options", options: [{
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gpt-5-large",
      options: [{ value: "gpt-5", name: "GPT-5" }, { value: "gpt-5-large", name: "GPT-5 Large" }],
      source: "config_option",
    }] })

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("maps ACP model and mode state to config options", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tangerine-acp-models-modes-"))
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockModelsModesAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test" }))
    const events: Record<string, unknown>[] = []
    handle.subscribe((event) => events.push(event as unknown as Record<string, unknown>))

    await waitFor(() => events.some((event) => event.kind === "config.options"))
    expect(events).toContainEqual({ kind: "config.options", options: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "sonnet",
        options: [{ value: "sonnet", name: "Sonnet", description: "Fast" }, { value: "opus", name: "Opus", description: "Deep" }],
        source: "model",
      },
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "default", name: "Default", description: "Ask" }, { value: "plan", name: "Plan", description: "Plan only" }],
        source: "mode",
      },
    ] })

    expect(await Effect.runPromise(handle.updateConfig?.({ model: "opus" }) ?? Effect.succeed(false))).toBe(true)
    expect(await Effect.runPromise(handle.updateConfig?.({ mode: "plan" }) ?? Effect.succeed(false))).toBe(true)
    await waitFor(() => events.some((event) => event.kind === "config.options" && Array.isArray(event.options) && event.options.some((option) => typeof option === "object" && option !== null && "currentValue" in option && option.currentValue === "opus")))
    await waitFor(() => events.some((event) => event.kind === "config.options" && Array.isArray(event.options) && event.options.some((option) => typeof option === "object" && option !== null && "currentValue" in option && option.currentValue === "plan")))

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("applies ACP mode config options", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tangerine-acp-mode-"))
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockModeAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test" }))
    const events: Record<string, unknown>[] = []
    handle.subscribe((event) => events.push(event as unknown as Record<string, unknown>))

    const updateConfig = handle.updateConfig as unknown as (config: { mode: string }) => Effect.Effect<boolean, Error>
    const applied = await Effect.runPromise(updateConfig({ mode: "code" }))
    await waitFor(() => events.some((event) => event.kind === "config.options" && Array.isArray(event.options) && event.options.some((option) => typeof option === "object" && option !== null && "currentValue" in option && option.currentValue === "code")))

    expect(applied).toBe(true)

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("sends ACP session/cancel on abort", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tangerine-acp-cancel-"))
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockCancelAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test" }))
    const events: AgentEvent[] = []
    handle.subscribe((event) => events.push(event))

    await Effect.runPromise(handle.abort())
    await waitFor(() => events.some((event) => event.kind === "thinking.streaming" && event.content === "cancelled"))

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("shutdown kills the ACP subprocess", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tangerine-acp-shutdown-"))
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockFreshAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test" }))

    expect(handle.isAlive?.()).toBe(true)
    await Effect.runPromise(handle.shutdown())
    await waitFor(() => handle.isAlive?.() === false)
    expect(handle.isAlive?.()).toBe(false)

    rmSync(tempDir, { recursive: true, force: true })
  })
})

async function waitFor(condition: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > 2_000) throw new Error("Timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const mockResumeAcpAgentScript = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, authMethods: [] } })
    return
  }
  if (msg.method === "session/resume") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-new" } })
    return
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`

const mockLoadAcpAgentScript = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, authMethods: [] } })
    return
  }
  if (msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-new" } })
    return
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`

const mockFreshAcpAgentScript = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-new" } })
    return
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`

const mockConfigAcpAgentScript = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
const options = (currentValue) => [{
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue,
  options: [{ value: "gpt-5", name: "GPT-5" }, { value: "gpt-5-large", name: "GPT-5 Large" }],
}]
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-config", configOptions: options("gpt-5") } })
    return
  }
  if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: options(msg.params.value) } })
    return
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`

const mockModelsModesAcpAgentScript = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      sessionId: "sess-models-modes",
      models: {
        currentModelId: "sonnet",
        availableModels: [
          { modelId: "sonnet", name: "Sonnet", description: "Fast" },
          { modelId: "opus", name: "Opus", description: "Deep" },
        ],
      },
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default", description: "Ask" },
          { id: "plan", name: "Plan", description: "Plan only" },
        ],
      },
    } })
    return
  }
  if (msg.method === "session/set_model" || msg.method === "session/set_mode") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
    return
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`

const mockModeAcpAgentScript = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
const options = (currentValue) => [{
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue,
  options: [{ value: "ask", name: "Ask" }, { value: "code", name: "Code" }],
}]
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-mode", configOptions: options("ask") } })
    return
  }
  if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: options(msg.params.value) } })
    return
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`

const mockCancelAcpAgentScript = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-cancel" } })
    return
  }
  if (msg.method === "session/cancel") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-cancel", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "cancelled" } } } })
  }
})
`

const mockAcpAgentScript = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
let pendingPromptId = null
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, close: {} } }, authMethods: [] } })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-test" } })
    return
  }
  if (msg.method === "session/prompt") {
    pendingPromptId = msg.id
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } } } })
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-test", update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Edit file", status: "pending", rawInput: { path: "/tmp/file" } } } })
    send({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "sess-test", toolCall: { toolCallId: "call-1", title: "Edit file", status: "pending" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } })
    return
  }
  if (msg.id === 99 && msg.result) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission:" + msg.result.outcome.optionId } } } })
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-test", update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { permission: msg.result.outcome.optionId } } } })
    send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } })
    return
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`
