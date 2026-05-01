import { useEffect, useRef, useCallback, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"
import { emitAuthFailure, getAuthToken } from "../lib/auth"
import { sendTerminalPong, sendTerminalResize } from "../lib/terminal-websocket"
import { createHeartbeatMonitor, type HeartbeatMonitor } from "../lib/ws-heartbeat"

interface TuiPaneProps {
  taskId: string
}

type ConnState = "connecting" | "connected" | "reconnecting" | "error" | "exited"

export function TuiPane({ taskId }: TuiPaneProps) {
  const wsPath = `/api/tasks/${taskId}/tui-terminal`
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartbeatRef = useRef<HeartbeatMonitor | null>(null)
  const backoffRef = useRef(1000)
  const disposedRef = useRef(false)
  const everConnectedRef = useRef(false)
  const hadErrorRef = useRef(false)
  const [connState, setConnState] = useState<ConnState>("connecting")
  const [exitCode, setExitCode] = useState<number | null>(null)

  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }))
    }
  }, [])

  const connect = useCallback(() => {
    const term = termRef.current
    if (!term || disposedRef.current) return

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const url = `${protocol}//${window.location.host}${wsPath}`
    heartbeatRef.current?.stop()

    const ws = new WebSocket(url)
    wsRef.current = ws

    const heartbeat = createHeartbeatMonitor(() => {
      if (disposedRef.current || wsRef.current !== ws) return
      if (ws.readyState < WebSocket.CLOSING) {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.onopen = null
          ws.onmessage = null
          ws.onerror = null
          ws.onclose = null
          ws.close()
          wsRef.current = null
          if (!disposedRef.current) {
            const delay = backoffRef.current
            backoffRef.current = Math.min(delay * 2, 5000)
            setConnState(everConnectedRef.current ? "reconnecting" : "connecting")
            reconnectTimerRef.current = setTimeout(connect, delay)
          }
        } else {
          ws.close()
        }
      }
    })
    heartbeatRef.current = heartbeat

    ws.onopen = () => {
      heartbeat.markAlive()
      backoffRef.current = 1000
      const token = getAuthToken()
      if (token) {
        ws.send(JSON.stringify({ type: "auth", token }))
      }
      requestAnimationFrame(() => {
        const fit = fitRef.current
        if (fit) {
          fit.fit()
          sendTerminalResize(ws, term)
        }
      })
    }

    ws.onmessage = (event) => {
      heartbeat.markAlive()
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.type === "ping") {
          sendTerminalPong(ws)
          return
        }
        if (msg.type === "connected") {
          everConnectedRef.current = true
          setConnState("connected")
          const fit = fitRef.current
          if (fit) {
            fit.fit()
            sendTerminalResize(ws, term)
          }
        } else if (msg.type === "scrollback") {
          term.clear()
          term.write(msg.data)
        } else if (msg.type === "output") {
          term.write(msg.data)
        } else if (msg.type === "exit") {
          setExitCode(msg.code)
          setConnState("exited")
        } else if (msg.type === "error") {
          hadErrorRef.current = true
          if (msg.message === "Unauthorized") emitAuthFailure()
          setConnState("error")
          term.writeln(`\r\n[Error: ${msg.message}]`)
        }
      } catch {
        // Ignore unparseable
      }
    }

    ws.onclose = () => {
      heartbeat.stop()
      if (heartbeatRef.current === heartbeat) heartbeatRef.current = null
      if (wsRef.current !== ws) return
      wsRef.current = null
      if (disposedRef.current) return
      const delay = backoffRef.current
      backoffRef.current = Math.min(delay * 2, 5000)
      if (hadErrorRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          if (disposedRef.current) return
          setConnState(everConnectedRef.current ? "reconnecting" : "connecting")
          connect()
        }, Math.max(delay, 2000))
      } else {
        setConnState(everConnectedRef.current ? "reconnecting" : "connecting")
        reconnectTimerRef.current = setTimeout(connect, delay)
      }
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [wsPath])

  useEffect(() => {
    if (!containerRef.current) return
    disposedRef.current = false

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: "#1a1a1a",
        foreground: "#e0e0e0",
        cursor: "#e0e0e0",
        selectionBackground: "#444",
      },
      scrollback: 10000,
      convertEol: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)

    termRef.current = term
    fitRef.current = fitAddon

    term.open(containerRef.current)
    fitAddon.fit()

    term.onData(sendInput)

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      sendTerminalResize(wsRef.current, term)
    })
    resizeObserver.observe(containerRef.current)

    connect()

    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = null
        }
        backoffRef.current = 1000
        setConnState(everConnectedRef.current ? "reconnecting" : "connecting")
        if (ws && ws.readyState === WebSocket.CONNECTING) {
          ws.onopen = null
          ws.onmessage = null
          ws.onerror = null
          ws.onclose = null
          ws.close()
          wsRef.current = null
        }
        connect()
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      disposedRef.current = true
      document.removeEventListener("visibilitychange", onVisibilityChange)
      resizeObserver.disconnect()
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      heartbeatRef.current?.stop()
      heartbeatRef.current = null
      const ws = wsRef.current
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
        wsRef.current = null
      }
      setConnState("connecting")
      setExitCode(null)
      everConnectedRef.current = false
      hadErrorRef.current = false
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [connect])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0 bg-card p-1" />
        {connState !== "connected" && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]">
            <span className="text-sm text-muted-foreground">
              {connState === "exited"
                ? `TUI exited${exitCode != null ? ` (code ${exitCode})` : ""}`
                : connState === "reconnecting"
                  ? "Reconnecting..."
                  : connState === "error"
                    ? "Connection error"
                    : "Connecting to agent TUI..."}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
