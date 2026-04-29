import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@tangerine/shared"
import { bufferTerminalOutput, drainPendingTerminalOutput, resolveAgentTuiLaunch, resolveAgentTuiLaunchForProvider, terminalSessionKey } from "../api/routes/terminal-ws"

describe("bufferTerminalOutput", () => {
  test("buffers live shadow output while a reconnecting client is replaying scrollback", () => {
    const client = {
      socket: { send() {}, close() {} },
      ready: false,
      pendingOutput: "",
    }

    expect(bufferTerminalOutput(client, "line 1\r\n")).toBeNull()
    expect(client.pendingOutput).toBe("line 1\r\n")
  })

  test("returns output immediately once the client is live", () => {
    const client = {
      socket: { send() {}, close() {} },
      ready: true,
      pendingOutput: "",
    }

    expect(bufferTerminalOutput(client, "line 2\r\n")).toBe("line 2\r\n")
    expect(client.pendingOutput).toBe("")
  })
})

describe("drainPendingTerminalOutput", () => {
  test("flushes buffered reconnect output exactly once", () => {
    const client = {
      socket: { send() {}, close() {} },
      ready: false,
      pendingOutput: "line 1\r\nline 2\r\n",
    }

    expect(drainPendingTerminalOutput(client)).toBe("line 1\r\nline 2\r\n")
    expect(client.pendingOutput).toBe("")
  })
})

describe("reconnect sequencing", () => {
  test("preserves output that arrives during scrollback replay", () => {
    const client = {
      socket: { send() {}, close() {} },
      ready: false,
      pendingOutput: "",
    }

    let delivered = "scrollback 1\r\nscrollback 2\r\n"

    expect(bufferTerminalOutput(client, "during replay\r\n")).toBeNull()
    expect(client.pendingOutput).toBe("during replay\r\n")

    client.ready = true
    delivered += drainPendingTerminalOutput(client)
    expect(delivered).toBe("scrollback 1\r\nscrollback 2\r\nduring replay\r\n")
    expect(client.pendingOutput).toBe("")

    expect(bufferTerminalOutput(client, "after ready\r\n")).toBe("after ready\r\n")
    expect(client.pendingOutput).toBe("")
  })
})

describe("agent TUI launch", () => {
  test("uses explicit agent TUI config with placeholders", () => {
    const agent: AgentConfig = {
      id: "custom",
      name: "Custom",
      command: "custom-acp",
      tui: {
        command: "custom",
        args: ["resume", "{sessionId}", "--cwd", "{worktree}"],
        env: { ACTIVE_SESSION: "{sessionId}", ACTIVE_WORKTREE: "{worktree}" },
      },
    }

    expect(resolveAgentTuiLaunch(agent, "sess-123", "/tmp/worktree")).toEqual({
      command: "custom",
      args: ["resume", "sess-123", "--cwd", "/tmp/worktree"],
      env: { ACTIVE_SESSION: "sess-123", ACTIVE_WORKTREE: "/tmp/worktree" },
    })
  })

  test("infers Codex TUI resume from common ACP adapter command", () => {
    const agent: AgentConfig = { id: "codex", name: "Codex", command: "codex-acp" }

    expect(resolveAgentTuiLaunch(agent, "sess-codex", "/tmp/worktree")).toEqual({
      command: "codex",
      args: ["resume", "sess-codex"],
      env: undefined,
    })
  })

  test("resolves the default ACP provider from the inherited ACP command", () => {
    const previous = process.env.TANGERINE_ACP_COMMAND
    process.env.TANGERINE_ACP_COMMAND = "codex-acp --model gpt-5"
    try {
      expect(resolveAgentTuiLaunchForProvider([], "acp", "sess-codex", "/tmp/worktree")).toEqual({
        command: "codex",
        args: ["resume", "sess-codex"],
        env: undefined,
      })
    } finally {
      if (previous === undefined) {
        delete process.env.TANGERINE_ACP_COMMAND
      } else {
        process.env.TANGERINE_ACP_COMMAND = previous
      }
    }
  })

  test("keeps shell and agent terminal sessions isolated", () => {
    expect(terminalSessionKey("task-1", "shell")).toBe("shell:task-1")
    expect(terminalSessionKey("task-1", "agent")).toBe("agent:task-1")
  })
})
