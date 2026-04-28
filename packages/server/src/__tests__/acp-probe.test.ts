import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { probeAcpAgent } from "../agent/acp-probe"

describe("probeAcpAgent", () => {
  test("summarizes ACP adapter capabilities, config, and stream events", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tangerine-acp-probe-"))
    const scriptPath = join(tempDir, "mock-acp-agent.js")
    writeFileSync(scriptPath, mockProbeAgentScript, "utf-8")

    const result = await probeAcpAgent({ id: "mock", name: "Mock", command: "bun", args: [scriptPath] }, {
      cwd: tempDir,
      prompt: "say hi",
      timeoutMs: 3_000,
      settleMs: 0,
    })

    expect(result.ok).toBe(true)
    expect(result.initialized).toBe(true)
    expect(result.sessionStarted).toBe(true)
    expect(result.promptRan).toBe(true)
    expect(result.capabilities).toEqual({ loadSession: true, imagePrompts: true, resume: true, close: true })
    expect(result.authMethods).toEqual(["mock-login:Mock login"])
    expect(result.session?.sessionId).toBe("sess-probe")
    expect(result.session?.hasLegacyModels).toBe(true)
    expect(result.session?.hasLegacyModes).toBe(true)
    expect(result.session?.configOptionCategories).toEqual(["thought_level", "model", "mode"])
    expect(result.events.rawUpdateCounts).toEqual({ agent_thought_chunk: 1, agent_message_chunk: 2, available_commands_update: 1 })
    expect(result.events.normalizedEventCounts).toEqual({ "thinking.streaming": 1, "message.streaming": 2, "thinking.complete": 1, "message.complete": 1 })
    expect(result.events.samples).toContainEqual({ sessionUpdate: "agent_message_chunk", contentType: "text", textLength: 3, hasMessageId: true })

    rmSync(tempDir, { recursive: true, force: true })
  })
})

const mockProbeAgentScript = String.raw`
const readline = require("node:readline")
const rl = readline.createInterface({ input: process.stdin })
function send(message) { process.stdout.write(JSON.stringify(message) + "\n") }
function result(id, value) { send({ jsonrpc: "2.0", id, result: value }) }
function notify(update) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-probe", update } }) }
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    result(msg.id, {
      protocolVersion: 1,
      agentInfo: { name: "mock-acp", title: "Mock ACP", version: "1.0.0" },
      authMethods: [{ id: "mock-login", name: "Mock login" }],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { resume: {}, close: {} }
      }
    })
    return
  }
  if (msg.method === "session/new") {
    result(msg.id, {
      sessionId: "sess-probe",
      configOptions: [{ id: "thought_level", name: "Thought", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] }],
      models: { currentModelId: "mock-model", availableModels: [{ modelId: "mock-model", name: "Mock Model" }] },
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] }
    })
    notify({ sessionUpdate: "available_commands_update", availableCommands: [] })
    return
  }
  if (msg.method === "session/prompt") {
    notify({ sessionUpdate: "agent_thought_chunk", messageId: "thought-1", content: { type: "text", text: "think" } })
    notify({ sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: "hel" } })
    notify({ sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: "lo" } })
    result(msg.id, { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
    return
  }
  if (msg.method === "session/close") {
    result(msg.id, {})
  }
})
`
