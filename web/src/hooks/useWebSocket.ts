import { useState, useEffect, useRef, useCallback } from "react"
import type { WsServerMessage, WsClientMessage } from "@tangerine/shared"

const MAX_BACKOFF = 30000

interface UseWebSocketResult {
  connected: boolean
  messages: WsServerMessage[]
  send: (msg: WsClientMessage) => void
  lastEvent: WsServerMessage | null
}

// Tag interface so we can associate a WebSocket with its task
interface TaggedWebSocket extends WebSocket {
  __taskId?: string
}

export function useWebSocket(taskId: string): UseWebSocketResult {
  const [connected, setConnected] = useState(false)
  const [messages, setMessages] = useState<WsServerMessage[]>([])
  const [lastEvent, setLastEvent] = useState<WsServerMessage | null>(null)
  const wsRef = useRef<TaggedWebSocket | null>(null)
  const backoffRef = useRef(1000)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountedRef = useRef(false)
  // Updated synchronously during render so send() can guard against stale WS
  const activeTaskIdRef = useRef(taskId)
  activeTaskIdRef.current = taskId

  const connect = useCallback(() => {
    if (unmountedRef.current) return

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const url = `${protocol}//${window.location.host}/api/tasks/${taskId}/ws`
    const ws: TaggedWebSocket = new WebSocket(url)
    ws.__taskId = taskId
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

  // Clear accumulated messages and close stale WebSocket when switching tasks
  // so neither history nor the connection from the previous task bleeds through.
  useEffect(() => {
    setMessages([])
    setConnected(false)
    // Eagerly close any WS opened for a different task. The connection effect
    // will create a fresh one, but closing here shrinks the race window where
    // send() could push through the old connection.
    const ws = wsRef.current
    if (ws && ws.__taskId !== taskId) {
      ws.close()
      wsRef.current = null
    }
  }, [taskId])

  useEffect(() => {
    unmountedRef.current = false
    connect()

    // When the page becomes visible again (e.g. iOS Safari returning from
    // background), force an immediate reconnect if the socket is closed.
    function onVisibilityChange() {
      if (document.visibilityState !== "visible" || unmountedRef.current) return
      if (!wsRef.current || wsRef.current.readyState >= WebSocket.CLOSING) {
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = null
        }
        backoffRef.current = 1000
        connect()
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      unmountedRef.current = true
      document.removeEventListener("visibilitychange", onVisibilityChange)
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
      }
      wsRef.current?.close()
    }
  }, [connect])

  const send = useCallback((msg: WsClientMessage) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    // Guard: don't send through a WebSocket opened for a different task
    if (ws.__taskId !== activeTaskIdRef.current) {
      console.warn(
        `[useWebSocket] Blocked send to stale WS (ws=${ws.__taskId}, active=${activeTaskIdRef.current})`,
      )
      return
    }
    ws.send(JSON.stringify(msg))
  }, [])

  return { connected, messages, send, lastEvent }
}
