import { describe, it, expect, beforeEach } from "bun:test"
import { WsManager } from "../api/ws-manager"
import type { WsServerMessage } from "@tangerine/shared"

/**
 * Tracer bullet: API -> WebSocket manager -> Event broadcast
 *
 * Tests the WsManager class that tracks WebSocket connections per task
 * and broadcasts events to all connected clients. Uses mock WebSocket
 * objects since we can't easily create real Bun ServerWebSocket in tests.
 */

/** Minimal mock of Bun's ServerWebSocket for testing */
interface MockWs {
  messages: string[]
  closed: boolean
  send(data: string): void
  close(): void
  data: { taskId: string }
}

function createMockWs(taskId: string): MockWs {
  return {
    messages: [],
    closed: false,
    data: { taskId },
    send(data: string) {
      if (!this.closed) {
        this.messages.push(data)
      }
    },
    close() {
      this.closed = true
    },
  }
}

describe("tracer: api -> websocket -> broadcast", () => {
  let manager: WsManager

  beforeEach(() => {
    manager = new WsManager()
  })

  it("broadcasts events to all connected clients for a task", () => {
    const client1 = createMockWs("task-1")
    const client2 = createMockWs("task-1")

    // WsManager uses ServerWebSocket<{ taskId: string }>, cast our mocks
    manager.add("task-1", client1 as never)
    manager.add("task-1", client2 as never)

    const event: WsServerMessage = {
      type: "event",
      data: { kind: "message.created", content: "Hello" },
    }
    manager.broadcast("task-1", event)

    expect(client1.messages).toHaveLength(1)
    expect(client2.messages).toHaveLength(1)

    const parsed1 = JSON.parse(client1.messages[0]!) as WsServerMessage
    const parsed2 = JSON.parse(client2.messages[0]!) as WsServerMessage
    expect(parsed1).toEqual(event)
    expect(parsed2).toEqual(event)
  })

  it("does not send to clients registered for a different task", () => {
    const client1 = createMockWs("task-1")
    const client2 = createMockWs("task-2")

    manager.add("task-1", client1 as never)
    manager.add("task-2", client2 as never)

    manager.broadcast("task-1", { type: "status", status: "running" })

    expect(client1.messages).toHaveLength(1)
    expect(client2.messages).toHaveLength(0)
  })

  it("removed client no longer receives broadcasts", () => {
    const client1 = createMockWs("task-1")
    const client2 = createMockWs("task-1")

    manager.add("task-1", client1 as never)
    manager.add("task-1", client2 as never)

    manager.remove("task-1", client1 as never)

    manager.broadcast("task-1", { type: "connected" })

    expect(client1.messages).toHaveLength(0)
    expect(client2.messages).toHaveLength(1)
  })

  it("broadcast to non-existent task does not error", () => {
    expect(() => {
      manager.broadcast("nonexistent", { type: "connected" })
    }).not.toThrow()
  })

  it("tracks client count per task", () => {
    const client1 = createMockWs("task-1")
    const client2 = createMockWs("task-1")

    expect(manager.getClientCount("task-1")).toBe(0)

    manager.add("task-1", client1 as never)
    expect(manager.getClientCount("task-1")).toBe(1)

    manager.add("task-1", client2 as never)
    expect(manager.getClientCount("task-1")).toBe(2)

    manager.remove("task-1", client1 as never)
    expect(manager.getClientCount("task-1")).toBe(1)

    manager.remove("task-1", client2 as never)
    expect(manager.getClientCount("task-1")).toBe(0)
  })

  it("handles multiple events in sequence", () => {
    const client = createMockWs("task-1")
    manager.add("task-1", client as never)

    const messages: WsServerMessage[] = [
      { type: "connected" },
      { type: "status", status: "provisioning" },
      { type: "status", status: "running" },
      { type: "event", data: { kind: "message.created" } },
      { type: "status", status: "done" },
    ]

    for (const msg of messages) {
      manager.broadcast("task-1", msg)
    }

    expect(client.messages).toHaveLength(5)

    // Verify order is preserved
    const parsed = client.messages.map((m) => JSON.parse(m) as WsServerMessage)
    expect(parsed[0]!.type).toBe("connected")
    expect(parsed[1]!.type).toBe("status")
    expect((parsed[1] as { type: "status"; status: string }).status).toBe("provisioning")
    expect(parsed[4]!.type).toBe("status")
    expect((parsed[4] as { type: "status"; status: string }).status).toBe("done")
  })

  it("handles send errors from disconnected clients gracefully", () => {
    const goodClient = createMockWs("task-1")
    const badClient = createMockWs("task-1")

    // Override send to throw (simulating a disconnected client)
    badClient.send = () => {
      throw new Error("WebSocket is closed")
    }

    manager.add("task-1", goodClient as never)
    manager.add("task-1", badClient as never)

    // Should not throw even though badClient.send throws
    expect(() => {
      manager.broadcast("task-1", { type: "connected" })
    }).not.toThrow()

    // Good client should still receive the message
    expect(goodClient.messages).toHaveLength(1)
  })

  it("supports status change broadcasts", () => {
    const client = createMockWs("task-1")
    manager.add("task-1", client as never)

    const statusMsg: WsServerMessage = { type: "status", status: "running" }
    manager.broadcast("task-1", statusMsg)

    const parsed = JSON.parse(client.messages[0]!) as WsServerMessage
    expect(parsed.type).toBe("status")
    expect((parsed as { type: "status"; status: string }).status).toBe("running")
  })

  it("supports error message broadcasts", () => {
    const client = createMockWs("task-1")
    manager.add("task-1", client as never)

    const errorMsg: WsServerMessage = { type: "error", message: "Agent crashed" }
    manager.broadcast("task-1", errorMsg)

    const parsed = JSON.parse(client.messages[0]!) as WsServerMessage
    expect(parsed.type).toBe("error")
    expect((parsed as { type: "error"; message: string }).message).toBe("Agent crashed")
  })
})
