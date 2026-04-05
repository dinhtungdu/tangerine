import type { ServerWebSocket } from "bun"
import type { WsServerMessage } from "@tangerine/shared"

/**
 * Tracks WebSocket connections per task so we can broadcast events
 * to all clients watching a given task.
 */
export class WsManager {
  private clients = new Map<string, Set<ServerWebSocket<{ taskId: string }>>>()

  add(taskId: string, ws: ServerWebSocket<{ taskId: string }>): void {
    let set = this.clients.get(taskId)
    if (!set) {
      set = new Set()
      this.clients.set(taskId, set)
    }
    set.add(ws)
  }

  remove(taskId: string, ws: ServerWebSocket<{ taskId: string }>): void {
    const set = this.clients.get(taskId)
    if (!set) return
    set.delete(ws)
    if (set.size === 0) {
      this.clients.delete(taskId)
    }
  }

  /** Send a message to all WebSocket clients watching a specific task */
  broadcast(taskId: string, message: WsServerMessage): void {
    const set = this.clients.get(taskId)
    if (!set) return
    const data = JSON.stringify(message)
    for (const ws of set) {
      try {
        ws.send(data)
      } catch {
        // Client may have disconnected; will be cleaned up on close
      }
    }
  }

  getClientCount(taskId: string): number {
    return this.clients.get(taskId)?.size ?? 0
  }
}
