import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import type { AgentEvent } from "../agent/provider"
import {
  AcpRpcConnection,
  buildAcpPromptBlocks,
  configOptionsFromAcpResponse,
  createAcpEventMapper,
  createAcpProvider,
  createPromptStatusTracker,
  DEFAULT_AGENT_STATUS_IDLE_DEBOUNCE_MS,
  resolveAcpCommand,
  selectSkipPermissionsMode,
  selectPermissionOption,
} from "../agent/acp-provider"

const originalAcpCommand = process.env.TANGERINE_ACP_COMMAND

afterEach(() => {
  if (originalAcpCommand === undefined) delete process.env.TANGERINE_ACP_COMMAND
  else process.env.TANGERINE_ACP_COMMAND = originalAcpCommand
  delete process.env.TANGERINE_ACP_SET_CONFIG_COUNT_FILE
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

describe("resolveAcpCommand", () => {
  test("defaults to acp-agent", () => {
    const command = resolveAcpCommand({})

    expect(command.shellCommand).toBe("acp-agent")
    expect(command.checkCommand).toBe("acp-agent")
    expect(command.availabilityCommand).toBe("acp-agent")
  })

  test("uses TANGERINE_ACP_COMMAND and extracts executable for system checks", () => {
    const command = resolveAcpCommand({ TANGERINE_ACP_COMMAND: "codex-acp --model gpt-5" })

    expect(command.shellCommand).toBe("codex-acp --model gpt-5")
    expect(command.checkCommand).toBe("codex-acp")
    expect(command.availabilityCommand).toBe("codex-acp")
  })

  test("extracts package name from bunx wrapper command", () => {
    const command = resolveAcpCommand({ TANGERINE_ACP_COMMAND: "bunx --bun @agentclientprotocol/claude-agent-acp" })

    expect(command.checkCommand).toBe("claude-agent-acp")
    expect(command.availabilityCommand).toBe("bunx")
  })

  test("extracts package name from npx wrapper command", () => {
    const command = resolveAcpCommand({ TANGERINE_ACP_COMMAND: "npx -y @agentclientprotocol/claude-agent-acp" })

    expect(command.checkCommand).toBe("claude-agent-acp")
    expect(command.availabilityCommand).toBe("npx")
  })

  test("extracts unscoped package name from bunx", () => {
    const command = resolveAcpCommand({ TANGERINE_ACP_COMMAND: "bunx claude-code-acp" })

    expect(command.checkCommand).toBe("claude-code-acp")
    expect(command.availabilityCommand).toBe("bunx")
  })

  test("handles yarn dlx package runner", () => {
    const command = resolveAcpCommand({ TANGERINE_ACP_COMMAND: "yarn dlx @scope/claude-acp" })

    expect(command.checkCommand).toBe("claude-acp")
    expect(command.availabilityCommand).toBe("yarn")
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

  test("adds ACP resource links for existing @file mentions", () => {
    const tempDir = createTempDir("tangerine-acp-files-")
    try {
      mkdirSync(join(tempDir, "web", "src"), { recursive: true })
      const filePath = join(tempDir, "web", "src", "ChatInput.tsx")
      writeFileSync(filePath, "export const ok = true\n")

      expect(buildAcpPromptBlocks("read @web/src/ChatInput.tsx", [], false, tempDir)).toEqual([
        { type: "text", text: "read @web/src/ChatInput.tsx" },
        {
          type: "resource_link",
          uri: pathToFileURL(filePath).href,
          name: "ChatInput.tsx",
          title: "web/src/ChatInput.tsx",
        },
      ])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("adds ACP resource links for selected file paths with spaces and brackets", () => {
    const tempDir = createTempDir("tangerine-acp-special-files-")
    try {
      mkdirSync(join(tempDir, "docs"), { recursive: true })
      mkdirSync(join(tempDir, "app"), { recursive: true })
      const notePath = join(tempDir, "docs", "My Note.md")
      const routePath = join(tempDir, "app", "[id].tsx")
      writeFileSync(notePath, "note\n")
      writeFileSync(routePath, "route\n")

      expect(buildAcpPromptBlocks("read @docs/My Note.md and @app/[id].tsx.", [], false, tempDir)).toEqual([
        { type: "text", text: "read @docs/My Note.md and @app/[id].tsx." },
        {
          type: "resource_link",
          uri: pathToFileURL(notePath).href,
          name: "My Note.md",
          title: "docs/My Note.md",
        },
        {
          type: "resource_link",
          uri: pathToFileURL(routePath).href,
          name: "[id].tsx",
          title: "app/[id].tsx",
        },
      ])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe("createPromptStatusTracker", () => {
  test("stays working until all overlapping prompt turns finish", () => {
    const statuses: Array<"idle" | "working"> = []
    const tracker = createPromptStatusTracker((status) => statuses.push(status), 0)

    const first = tracker.begin()
    const second = tracker.begin()
    tracker.end(first)
    expect(statuses).toEqual(["working"])
    expect(tracker.isWorking()).toBe(true)

    tracker.end(second)
    expect(statuses).toEqual(["working", "idle"])
    expect(tracker.isWorking()).toBe(false)
  })

  test("debounces idle when a late tool update follows a prompt result", async () => {
    const statuses: Array<"idle" | "working"> = []
    const tracker = createPromptStatusTracker((status) => statuses.push(status), 10)

    const turn = tracker.begin()
    tracker.end(turn)
    expect(statuses).toEqual(["working"])

    tracker.toolStart("call-late")
    tracker.toolEnd("call-late")
    expect(statuses).toEqual(["working"])

    await delay(20)
    expect(statuses).toEqual(["working", "idle"])
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

describe("selectSkipPermissionsMode", () => {
  test("selects Claude bypass permissions before Codex full access", () => {
    expect(selectSkipPermissionsMode([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: [
          { value: "full-access", name: "Full Access" },
          { value: "bypassPermissions", name: "Bypass Permissions" },
        ],
      },
    ])).toBe("bypassPermissions")
  })

  test("selects Codex full access when Claude bypass is unavailable", () => {
    expect(selectSkipPermissionsMode([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "auto",
        options: [
          { value: "read-only", name: "Read Only" },
          { value: "full-access", name: "Full Access" },
        ],
      },
    ])).toBe("full-access")
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

  test("splits sentence-boundary chunks without message IDs into narration messages", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Using test-driven-development. First: specs/tests, then implementation, then PR." } }))
      .toEqual([{ kind: "message.streaming", role: "narration", content: "Using test-driven-development. First: specs/tests, then implementation, then PR." }])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Setup done, worktree clean." } }))
      .toEqual([
        { kind: "message.complete", role: "narration", content: "Using test-driven-development. First: specs/tests, then implementation, then PR." },
        { kind: "message.streaming", role: "narration", content: "Setup done, worktree clean." },
      ])
    expect(mapper.flushAssistantMessage()).toEqual([{ kind: "message.complete", role: "narration", content: "Setup done, worktree clean." }])
  })

  test("flushes a single no-messageId prose chunk as narration", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking current task logs." } }))
      .toEqual([{ kind: "message.streaming", role: "narration", content: "Checking current task logs." }])
    expect(mapper.flushAssistantMessage()).toEqual([{ kind: "message.complete", role: "narration", content: "Checking current task logs." }])
  })

  test("flushes remaining no-messageId prose as assistant on prompt completion", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PR #680 updates ACP stream mapping." } }))
      .toEqual([{ kind: "message.streaming", role: "narration", content: "PR #680 updates ACP stream mapping." }])
    expect(mapper.flushAssistantMessage("assistant")).toEqual([{ kind: "message.complete", role: "assistant", content: "PR #680 updates ACP stream mapping." }])
  })

  test("flushes no-messageId narration before visible tool events", () => {
    const mapper = createAcpEventMapper()

    mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking PR details." } })

    expect(mapper.mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "GitHub" }))
      .toEqual([
        { kind: "message.complete", role: "narration", content: "Checking PR details." },
        { kind: "tool.start", toolCallId: "call-1", toolName: "GitHub", toolInput: undefined },
      ])

    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PR #680 updates ACP stream mapping." } }))
      .toEqual([{ kind: "message.streaming", role: "narration", content: "PR #680 updates ACP stream mapping." }])
    expect(mapper.flushAssistantMessage("assistant")).toEqual([{ kind: "message.complete", role: "assistant", content: "PR #680 updates ACP stream mapping." }])
  })

  test("does not split dotted identifiers across no-messageId chunks", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Use Foo." } }))
      .toEqual([{ kind: "message.streaming", role: "narration", content: "Use Foo." }])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Bar value" } }))
      .toEqual([{ kind: "message.streaming", role: "narration", content: "Bar value" }])
    expect(mapper.flushAssistantMessage()).toEqual([{ kind: "message.complete", role: "narration", content: "Use Foo.Bar value" }])
  })

  test("starts a new assistant message when ACP messageId changes", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: "First." } }))
      .toEqual([{ kind: "message.streaming", content: "First.", messageId: "msg-1" }])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", messageId: "msg-2", content: { type: "text", text: "Second." } }))
      .toEqual([
        { kind: "message.complete", role: "assistant", content: "First.", messageId: "msg-1" },
        { kind: "message.streaming", content: "Second.", messageId: "msg-2" },
      ])
    expect(mapper.flushAssistantMessage()).toEqual([{ kind: "message.complete", role: "assistant", content: "Second.", messageId: "msg-2" }])
  })

  test("separates no-messageId narration before messageId assistant text", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking current task logs." } }))
      .toEqual([{ kind: "message.streaming", role: "narration", content: "Checking current task logs." }])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: "Done." } }))
      .toEqual([
        { kind: "message.complete", role: "narration", content: "Checking current task logs." },
        { kind: "message.streaming", content: "Done.", messageId: "msg-1" },
      ])
    expect(mapper.flushAssistantMessage()).toEqual([{ kind: "message.complete", role: "assistant", content: "Done.", messageId: "msg-1" }])
  })

  test("separates messageId assistant text before no-messageId narration", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: "Done." } }))
      .toEqual([{ kind: "message.streaming", content: "Done.", messageId: "msg-1" }])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Checking current task logs." } }))
      .toEqual([
        { kind: "message.complete", role: "assistant", content: "Done.", messageId: "msg-1" },
        { kind: "message.streaming", role: "narration", content: "Checking current task logs." },
      ])
    expect(mapper.flushAssistantMessage()).toEqual([{ kind: "message.complete", role: "narration", content: "Checking current task logs." }])
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

  test("splits no-id thought chunks at clear sentence boundaries", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspecting current files." } }))
      .toEqual([{ kind: "thinking.streaming", content: "Inspecting current files.", messageId: "thought-1" }])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Running focused tests." } }))
      .toEqual([
        { kind: "thinking.complete", content: "Inspecting current files.", messageId: "thought-1" },
        { kind: "thinking.streaming", content: "Running focused tests.", messageId: "thought-2" },
      ])
    expect(mapper.flushThoughtMessage()).toEqual([{ kind: "thinking.complete", content: "Running focused tests.", messageId: "thought-2" }])
  })

  test("starts a new thought block after visible non-thought events", () => {
    const mapper = createAcpEventMapper()

    mapper.mapSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I should inspect." } })
    expect(mapper.mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read file" }))
      .toEqual([
        { kind: "thinking.complete", content: "I should inspect.", messageId: "thought-1" },
        { kind: "tool.start", toolCallId: "call-1", toolName: "Read file", toolInput: undefined },
      ])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Now review result." } }))
      .toEqual([{ kind: "thinking.streaming", content: "Now review result.", messageId: "thought-2" }])
  })

  test("preserves order when thought follows assistant text", () => {
    const mapper = createAcpEventMapper()

    mapper.mapSessionUpdate({ sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: "Result." } })
    expect(mapper.mapSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Double-checking." } }))
      .toEqual([
        { kind: "message.complete", role: "assistant", content: "Result.", messageId: "msg-1" },
        { kind: "thinking.streaming", content: "Double-checking.", messageId: "thought-1" },
      ])
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
      .toEqual([{ kind: "tool.start", toolCallId: "call-1", toolName: "Read file", toolInput: "{\"path\":\"/tmp/a.ts\"}" }])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { ok: true } }))
      .toEqual([{ kind: "tool.end", toolCallId: "call-1", toolName: "Read file", toolResult: "{\"ok\":true}", status: "success" }])
    expect(mapper.mapSessionUpdate({ sessionUpdate: "usage_update", used: 123, size: 1000 }))
      .toEqual([{ kind: "usage", contextTokens: 123, contextWindowMax: 1000 }])
    expect(mapper.mapSessionUpdate({
      sessionUpdate: "session_info_update",
      title: "Implement auth",
      updatedAt: "2026-04-27T10:00:00.000Z",
      _meta: { tags: ["auth"] },
    })).toEqual([{ kind: "session.info", title: "Implement auth", updatedAt: "2026-04-27T10:00:00.000Z", metadata: { tags: ["auth"] } }])
  })

  test("maps in-progress ACP tool call updates to tool updates", () => {
    const mapper = createAcpEventMapper()

    mapper.mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "Bash", status: "pending", rawInput: { command: "bun test" } })

    expect(mapper.mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "1/2 tests passed" } }],
    })).toEqual([{ kind: "tool.update", toolCallId: "call-1", toolName: "Bash", toolResult: "1/2 tests passed", status: "running" }])
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
      { kind: "tool.update", toolCallId: "edit-1", toolName: "edit-1", status: "running" },
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

  test("maps available command updates", () => {
    const mapper = createAcpEventMapper()

    expect(mapper.mapSessionUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "compact", description: "Compact conversation", input: { hint: "instructions" } },
        { name: "help", description: "Show help" },
        { name: "", description: "ignored" },
      ],
    })).toEqual([{ kind: "slash.commands", commands: [
      { name: "compact", description: "Compact conversation", input: { hint: "instructions" } },
      { name: "help", description: "Show help" },
    ] }])
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

  test("runs an ACP stdio agent without treating prompt token usage as context usage", async () => {
    const tempDir = createTempDir("tangerine-acp-provider-")
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test" }))

    const events: AgentEvent[] = []
    handle.subscribe((event) => events.push(event))

    await Effect.runPromise(handle.sendPrompt("hi", [{ mediaType: "image/png", data: "abc" }]))
    await waitFor(() => hasStatusTransition(events, "working", "idle"))
    await Effect.runPromise(handle.shutdown())

    expect((handle as { __meta?: { sessionId: string } }).__meta?.sessionId).toBe("sess-test")
    expect(events).toContainEqual({ kind: "status", status: "working" })
    expect(events).toContainEqual({ kind: "message.streaming", content: "hello ", messageId: "msg-test" })
    expect(events).toContainEqual({ kind: "message.streaming", content: "permission:allow", messageId: "msg-test" })
    expect(events).toContainEqual({ kind: "tool.start", toolCallId: "call-1", toolName: "Edit file", toolInput: "{\"path\":\"/tmp/file\"}" })
    expect(events).toContainEqual({
      kind: "permission.decision",
      toolName: "Edit file",
      optionId: "allow",
      optionName: "Allow",
      optionKind: "allow_once",
    })
    expect(events).toContainEqual({ kind: "tool.end", toolCallId: "call-1", toolName: "Edit file", toolResult: "{\"permission\":\"allow\"}", status: "success" })
    expect(events).toContainEqual({ kind: "message.complete", role: "assistant", content: "hello permission:allow", messageId: "msg-test" })
    expect(events).toContainEqual({ kind: "usage", inputTokens: 10, outputTokens: 5, cumulative: true })
    expect(events).toContainEqual({ kind: "status", status: "idle" })

    rmSync(tempDir, { recursive: true, force: true })
  })

  test("does not carry out-of-turn assistant chunks into the next prompt", async () => {
    const tempDir = createTempDir("tangerine-acp-stale-chunk-")
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockOutOfTurnChunkAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP stale chunk" }))

    const events: AgentEvent[] = []
    handle.subscribe((event) => events.push(event))

    await Effect.runPromise(handle.sendPrompt("first"))
    await waitFor(() => events.some((event) => event.kind === "message.complete" && event.content === "first"))
    await new Promise((resolve) => setTimeout(resolve, 40))

    await Effect.runPromise(handle.sendPrompt("second"))
    await waitFor(() => events.filter((event) => event.kind === "message.complete").length === 2)
    await Effect.runPromise(handle.shutdown())

    const completed = events.filter((event): event is Extract<AgentEvent, { kind: "message.complete" }> => event.kind === "message.complete")
    expect(completed.map((event) => event.content)).toEqual(["first", "second"])

    rmSync(tempDir, { recursive: true, force: true })
  })

  test("replays current ACP status to late subscribers", async () => {
    const tempDir = createTempDir("tangerine-acp-status-")
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockSlowAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP status" }))

    await Effect.runPromise(handle.sendPrompt("slow"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const events: AgentEvent[] = []
    handle.subscribe((event) => events.push(event))

    expect(events).toContainEqual({ kind: "status", status: "working" })
    await waitFor(() => events.some((event) => event.kind === "status" && event.status === "idle"))

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("replays idle ACP status to late subscribers after session start", async () => {
    const tempDir = createTempDir("tangerine-acp-idle-status-")
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockFreshAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP idle status" }))

    const events: AgentEvent[] = []
    handle.subscribe((event) => events.push(event))

    expect(events).toContainEqual({ kind: "status", status: "idle" })

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("keeps status working for late tool updates inside the idle debounce window", async () => {
    const tempDir = createTempDir("tangerine-acp-late-tool-status-")
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockLateToolUpdateAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP late tool status" }))

    const events: AgentEvent[] = []
    handle.subscribe((event) => events.push(event))

    await Effect.runPromise(handle.sendPrompt("run late tool"))
    await waitFor(() => events.some((event) => event.kind === "tool.end"))
    await delay(DEFAULT_AGENT_STATUS_IDLE_DEBOUNCE_MS + 50)

    const statuses = events.filter((event): event is Extract<AgentEvent, { kind: "status" }> => event.kind === "status").map((event) => event.status)
    expect(statuses).toEqual(["idle", "working", "idle"])

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("advertises ACP filesystem callbacks and handles read/write requests", async () => {
    const tempDir = realpathSync(createTempDir("tangerine-acp-fs-"))
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockFsAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP fs" }))
    const events: AgentEvent[] = []
    handle.subscribe((event) => events.push(event))

    await Effect.runPromise(handle.sendPrompt("write and read"))
    await waitFor(() => hasStatusTransition(events, "working", "idle"), 10_000)

    expect(await Bun.file(join(tempDir, "edited.txt")).text()).toBe("edited content")
    expect(events).toContainEqual({ kind: "message.complete", role: "assistant", content: "fs:edited content", messageId: "msg-fs" })

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  }, 15_000)

  test("resumes existing ACP sessions when supported", async () => {
    const tempDir = createTempDir("tangerine-acp-resume-")
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
    const tempDir = createTempDir("tangerine-acp-load-")
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
    const tempDir = createTempDir("tangerine-acp-fresh-")
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
    const tempDir = createTempDir("tangerine-acp-config-")
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

  test("applies ACP effort config options", async () => {
    const tempDir = createTempDir("tangerine-acp-effort-")
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockEffortAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test" }))
    const events: Record<string, unknown>[] = []
    handle.subscribe((event) => events.push(event as unknown as Record<string, unknown>))

    await waitFor(() => events.some((event) => event.kind === "config.options"))
    expect(events).toContainEqual({ kind: "config.options", options: [{
      id: "effort",
      name: "Effort",
      category: "effort",
      type: "select",
      currentValue: "medium",
      options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "xhigh", name: "XHigh" }],
      source: "config_option",
    }] })

    expect(await Effect.runPromise(handle.updateConfig?.({ reasoningEffort: "xhigh" }) ?? Effect.succeed(false))).toBe(true)
    await waitFor(() => events.some((event) => event.kind === "config.options" && Array.isArray(event.options) && event.options.some((option) => typeof option === "object" && option !== null && "currentValue" in option && option.currentValue === "xhigh")))

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("maps ACP model and mode state to config options", async () => {
    const tempDir = createTempDir("tangerine-acp-models-modes-")
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

  test("maps legacy thinking modes to ACP thought_level options", async () => {
    expect(configOptionsFromAcpResponse({
      modes: {
        currentModeId: "medium",
        availableModes: [
          { id: "off", name: "Thinking: off" },
          { id: "minimal", name: "Thinking: minimal" },
          { id: "low", name: "Thinking: low" },
          { id: "medium", name: "Thinking: medium" },
          { id: "high", name: "Thinking: high" },
          { id: "xhigh", name: "Thinking: xhigh" },
        ],
      },
    })).toEqual([{
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "off", name: "Thinking: off" },
        { value: "minimal", name: "Thinking: minimal" },
        { value: "low", name: "Thinking: low" },
        { value: "medium", name: "Thinking: medium" },
        { value: "high", name: "Thinking: high" },
        { value: "xhigh", name: "Thinking: xhigh" },
      ],
      source: "mode",
    }])
  })

  test("applies legacy thinking modes through session/set_mode", async () => {
    const tempDir = createTempDir("tangerine-acp-thinking-modes-")
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockThinkingModesAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test" }))
    const events: Record<string, unknown>[] = []
    handle.subscribe((event) => events.push(event as unknown as Record<string, unknown>))

    await waitFor(() => events.some((event) => event.kind === "config.options"))
    expect(events).toContainEqual({ kind: "config.options", options: [{
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [{ value: "low", name: "Thinking: low" }, { value: "medium", name: "Thinking: medium" }, { value: "high", name: "Thinking: high" }],
      source: "mode",
    }] })

    expect(await Effect.runPromise(handle.updateConfig?.({ reasoningEffort: "high" }) ?? Effect.succeed(false))).toBe(true)
    await waitFor(() => events.some((event) => event.kind === "config.options" && Array.isArray(event.options) && event.options.some((option) => typeof option === "object" && option !== null && "currentValue" in option && option.currentValue === "high")))

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("applies ACP mode config options", async () => {
    const tempDir = createTempDir("tangerine-acp-mode-")
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

  test("applies skipPermissions mode at session start", async () => {
    const tempDir = createTempDir("tangerine-acp-skip-permissions-")
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockSkipPermissionsAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test", permissionMode: "skipPermissions" }))

    expect(handle.getConfigOptions?.()[0]?.currentValue).toBe("full-access")

    await Effect.runPromise(handle.shutdown())
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("applies skipPermissions mode once during config option bursts", async () => {
    const tempDir = createTempDir("tangerine-acp-skip-permissions-burst-")
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    const countPath = join(tempDir, "set-config-count.txt")
    writeFileSync(scriptPath, mockBurstSkipPermissionsAcpAgentScript, "utf-8")

    process.env.TANGERINE_ACP_COMMAND = `bun ${scriptPath}`
    process.env.TANGERINE_ACP_SET_CONFIG_COUNT_FILE = countPath
    const provider = createAcpProvider()
    const handle = await Effect.runPromise(provider.start({ taskId: "task-acp", workdir: tempDir, title: "ACP test", permissionMode: "skipPermissions" }))

    expect(handle.getConfigOptions?.()[0]?.currentValue).toBe("full-access")
    expect(readFileSync(countPath, "utf-8")).toBe("1")

    await Effect.runPromise(handle.shutdown())
    delete process.env.TANGERINE_ACP_SET_CONFIG_COUNT_FILE
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("sends ACP session/cancel on abort", async () => {
    const tempDir = createTempDir("tangerine-acp-cancel-")
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
    const tempDir = createTempDir("tangerine-acp-shutdown-")
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

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function hasStatusTransition(events: AgentEvent[], from: "idle" | "working", to: "idle" | "working"): boolean {
  let seenFrom = false
  for (const event of events) {
    if (event.kind !== "status") continue
    if (event.status === from) seenFrom = true
    if (seenFrom && event.status === to) return true
  }
  return false
}

const mockSlowAcpAgentScript = `
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
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-status" } })
    return
  }
  if (msg.method === "session/prompt") {
    const id = msg.id
    setTimeout(() => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }), 120)
    return
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`

const mockLateToolUpdateAcpAgentScript = `
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
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-late-tool" } })
    return
  }
  if (msg.method === "session/prompt") {
    const promptId = msg.id
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } })
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-late-tool", update: { sessionUpdate: "tool_call_update", toolCallId: "call-late", title: "Bash", status: "in_progress", rawOutput: "running" } } })
    }, 20)
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-late-tool", update: { sessionUpdate: "tool_call_update", toolCallId: "call-late", title: "Bash", status: "completed", rawOutput: "done" } } })
    }, 60)
    return
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`

const mockOutOfTurnChunkAcpAgentScript = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
let promptCount = 0
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
function chunk(text) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-stale", update: { sessionUpdate: "agent_message_chunk", messageId: "msg-" + promptCount, content: { type: "text", text } } } })
}
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-stale" } })
    return
  }
  if (msg.method === "session/prompt") {
    promptCount += 1
    if (promptCount === 1) {
      chunk("first")
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } })
      setTimeout(() => chunk("first"), 20)
      return
    }
    chunk("second")
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } })
    return
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`

const mockFsAcpAgentScript = `
const readline = require("node:readline")
const path = require("node:path")
const rl = readline.createInterface({ input: process.stdin })
let promptId = null
let wrote = false
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    if (!msg.params.clientCapabilities?.fs?.readTextFile || !msg.params.clientCapabilities?.fs?.writeTextFile) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "missing fs capabilities" } })
      return
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-fs" } })
    return
  }
  if (msg.method === "session/prompt") {
    promptId = msg.id
    send({ jsonrpc: "2.0", id: 201, method: "fs/write_text_file", params: { sessionId: "sess-fs", path: path.join(process.cwd(), "edited.txt"), content: "edited content" } })
    return
  }
  if (msg.id === 201 && msg.result) {
    wrote = true
    send({ jsonrpc: "2.0", id: 202, method: "fs/read_text_file", params: { sessionId: "sess-fs", path: path.join(process.cwd(), "edited.txt") } })
    return
  }
  if (msg.id === 202 && msg.result && wrote) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-fs", update: { sessionUpdate: "agent_message_chunk", messageId: "msg-fs", content: { type: "text", text: "fs:" + msg.result.content } } } })
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } })
    return
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`

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

const mockEffortAcpAgentScript = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
const options = (currentValue) => [{
  id: "effort",
  name: "Effort",
  category: "effort",
  type: "select",
  currentValue,
  options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "xhigh", name: "XHigh" }],
}]
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-effort", configOptions: options("medium") } })
    return
  }
  if (msg.method === "session/set_config_option") {
    if (msg.params.configId !== "effort") throw new Error("expected effort config")
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

const mockThinkingModesAcpAgentScript = `
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
      sessionId: "sess-thinking-modes",
      modes: {
        currentModeId: "medium",
        availableModes: [
          { id: "low", name: "Thinking: low" },
          { id: "medium", name: "Thinking: medium" },
          { id: "high", name: "Thinking: high" },
        ],
      },
    } })
    return
  }
  if (msg.method === "session/set_mode") {
    if (msg.params.modeId !== "high") throw new Error("expected modeId high")
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

const mockSkipPermissionsAcpAgentScript = `
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
const options = (currentValue) => [{
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue,
  options: [{ value: "auto", name: "Auto" }, { value: "full-access", name: "Full Access" }],
}]
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-skip", configOptions: options("auto") } })
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

const mockBurstSkipPermissionsAcpAgentScript = `
const fs = require("node:fs")
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
let setConfigCount = 0
function writeCount() { fs.writeFileSync(process.env.TANGERINE_ACP_SET_CONFIG_COUNT_FILE, String(setConfigCount)) }
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n") }
const options = (currentValue) => [{
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue,
  options: [{ value: "auto", name: "Auto" }, { value: "full-access", name: "Full Access" }],
}]
writeCount()
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-skip-burst", configOptions: options("auto") } })
    return
  }
  if (msg.method === "session/set_config_option") {
    setConfigCount++
    writeCount()
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-skip-burst", update: { sessionUpdate: "config_option_update", configOptions: options("auto") } } })
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-skip-burst", update: { sessionUpdate: "config_option_update", configOptions: options("auto") } } })
    setTimeout(() => {
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: options(msg.params.value) } })
    }, 20)
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
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-test", update: { sessionUpdate: "agent_message_chunk", messageId: "msg-test", content: { type: "text", text: "hello " } } } })
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-test", update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Edit file", status: "pending", rawInput: { path: "/tmp/file" } } } })
    send({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: { sessionId: "sess-test", toolCall: { toolCallId: "call-1", title: "Edit file", status: "pending" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] } })
    return
  }
  if (msg.id === 99 && msg.result) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-test", update: { sessionUpdate: "agent_message_chunk", messageId: "msg-test", content: { type: "text", text: "permission:" + msg.result.outcome.optionId } } } })
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-test", update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { permission: msg.result.outcome.optionId } } } })
    send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } })
    return
  }
  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`
