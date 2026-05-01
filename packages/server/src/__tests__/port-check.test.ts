import { describe, test, expect, afterAll } from "bun:test"
import { createServer, type Server } from "net"
import { checkPort, preflightPorts } from "../cli/port-check"

let testServer: Server | null = null

function startTcpServer(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(port, "127.0.0.1", () => resolve(server))
    server.on("error", reject)
  })
}

afterAll(() => {
  testServer?.close()
})

describe("checkPort", () => {
  test("free port returns status free", async () => {
    const result = await checkPort(59123, "127.0.0.1")
    expect(result.status).toBe("free")
  })

  test("occupied port returns occupied or tangerine", async () => {
    testServer = await startTcpServer(59124)
    const result = await checkPort(59124, "127.0.0.1")
    expect(result.status).not.toBe("free")
    testServer.close()
    testServer = null
  })
})

describe("preflightPorts", () => {
  test("all free returns ok", async () => {
    const result = await preflightPorts(59125, 59126, "127.0.0.1")
    expect(result.ok).toBe(true)
  })

  test("http port only, free returns ok", async () => {
    const result = await preflightPorts(59127, null, "127.0.0.1")
    expect(result.ok).toBe(true)
  })

  test("occupied http port returns not ok", async () => {
    testServer = await startTcpServer(59128)
    const result = await preflightPorts(59128, null, "127.0.0.1")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("HTTP port 59128")
      expect(result.alreadyRunning).toBe(false)
    }
    testServer.close()
    testServer = null
  })

  test("occupied ssl port returns not ok", async () => {
    testServer = await startTcpServer(59130)
    const result = await preflightPorts(59129, 59130, "127.0.0.1")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("HTTPS port 59130")
    }
    testServer.close()
    testServer = null
  })
})
