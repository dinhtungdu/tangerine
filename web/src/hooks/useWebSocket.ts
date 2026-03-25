import { useState, useEffect, useRef, useCallback } from "react"
import type { WsServerMessage, WsClientMessage } from "@tangerine/shared"

const MAX_BACKOFF = 30000

interface UseWebSocketResult {
  connected: boolean
  messages: WsServerMessage[]
  send: (msg: WsClientMessage) => void
  lastEvent: WsServerMessage | null
}

export function useWebSocket(taskId: string): UseWebSocketResult {
  const [connected, setConnected] = useState(false)
  const [messages, setMessages] = useState<WsServerMessage[]>([])
  const [lastEvent, setLastEvent] = useState<WsServerMessage | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const backoffRef = useRef(1000)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountedRef = useRef(false)

  const connect = useCallback(() => {
    if (unmountedRef.current) return

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const url = `${protocol}//${window.location.host}/api/tasks/${taskId}/ws`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      if (unmountedRef.current) return
      setConnected(true)
      backoffRef.current = 1000
    }

    ws.onmessage = (event) => {
      if (unmountedRef.current) return
      try {
        const msg = JSON.parse(event.data as string) as WsServerMessage
        setMessages((prev) => [...prev, msg])
        setLastEvent(msg)
      } catch {
        // Ignore unparseable messages
      }
    }

    ws.onclose = () => {
      if (unmountedRef.current) return
      // Guard against stale close events from a previous connection. When the
      // taskId changes, cleanup closes the old WS but the new one is already
      // assigned to wsRef. Without this check the stale onclose would null out
      // the new connection and schedule a reconnect to the wrong task.
      if (wsRef.current !== ws) return
      setConnected(false)
      wsRef.current = null

      // Reconnect with exponential backoff
      const delay = backoffRef.current
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF)
      reconnectTimerRef.current = setTimeout(connect, delay)
    }

    ws.onerror = () => {
      // onclose will fire after onerror, triggering reconnect
      ws.close()
    }
  }, [taskId])

  // Clear accumulated messages when switching to a different task so stale
  // WS history from the previous task doesn't bleed into the new one.
  useEffect(() => {
    setMessages([])
    setConnected(false)
  }, [taskId])

  useEffect(() => {
    unmountedRef.current = false
    connect()

    return () => {
      unmountedRef.current = true
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      wsRef.current?.close()
    }
  }, [connect])

  const send = useCallback((msg: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  return { connected, messages, send, lastEvent }
}
