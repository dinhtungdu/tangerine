import { describe, expect, test } from "bun:test"
import { bufferTerminalOutput, drainPendingTerminalOutput } from "../api/routes/terminal-ws"

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
