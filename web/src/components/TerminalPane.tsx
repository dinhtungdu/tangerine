import { useEffect, useRef, useCallback, useState } from "react"
import { Terminal, useTerminal } from "@wterm/react"
import "@wterm/react/css"
import { TerminalToolbar } from "./TerminalToolbar"
import { emitAuthFailure, getAuthToken } from "../lib/auth"
import { sendTerminalPong } from "../lib/terminal-websocket"
import { createHeartbeatMonitor, type HeartbeatMonitor } from "../lib/ws-heartbeat"

type TerminalPaneProps =
  | { taskId: string; wsUrl?: never }
  | { taskId?: never; wsUrl: string }

type ConnState = "connecting" | "connected" | "reconnecting" | "error" | "unavailable"

export function TerminalPane(props: TerminalPaneProps) {
  const wsPath = props.wsUrl ?? `/api/tasks/${props.taskId}/terminal`
  const wrapperRef = useRef<HTMLDivElement>(null)
  const { ref: termRef, write } = useTerminal()
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartbeatRef = useRef<HeartbeatMonitor | null>(null)
  const backoffRef = useRef(1000)
  const disposedRef = useRef(false)
  const everConnectedRef = useRef(false)
  const hadErrorRef = useRef(false)
  const permanentErrorRef = useRef(false)
  const [connState, setConnState] = useState<ConnState>("connecting")

  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }))
    }
  }, [])

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }))
    }
  }, [])

  const connect = useCallback(() => {
    if (!termRef.current || disposedRef.current) return
    if (permanentErrorRef.current) return
    hadErrorRef.current = false

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
        const handle = termRef.current
        if (handle?.instance) {
          sendResize(handle.instance.cols, handle.instance.rows)
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
          const handle = termRef.current
          if (handle?.instance) {
            sendResize(handle.instance.cols, handle.instance.rows)
          }
        } else if (msg.type === "scrollback") {
          write("\x1b[2J\x1b[H")
          write(msg.data)
        } else if (msg.type === "output") {
          write(msg.data)
        } else if (msg.type === "exit") {
          write(`\r\n[Process exited with code ${msg.code}]\r\n`)
        } else if (msg.type === "error") {
          if (msg.message?.includes("no worktree") || msg.message?.includes("not available") || msg.message?.includes("missing session id")) {
            permanentErrorRef.current = true
            setConnState("unavailable")
          } else {
            hadErrorRef.current = true
            if (msg.message === "Unauthorized") emitAuthFailure()
            setConnState("error")
            write(`\r\n[Error: ${msg.message}]\r\n`)
          }
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
      if (permanentErrorRef.current) return
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
  }, [wsPath, sendResize, write, termRef])

  const [viewportHeight, setViewportHeight] = useState<number | null>(null)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    function onResize() {
      const vv = window.visualViewport!
      if (window.innerHeight - vv.height > 100) {
        const el = wrapperRef.current
        if (el) {
          const topInViewport = el.getBoundingClientRect().top - (vv.offsetTop ?? 0)
          setViewportHeight(Math.max(vv.height - topInViewport, 100))
        } else {
          setViewportHeight(vv.height)
        }
      } else {
        setViewportHeight(null)
      }
    }

    vv.addEventListener("resize", onResize)
    return () => vv.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    if (viewportHeight == null) return
    const handle = termRef.current
    if (!handle?.instance) return
    requestAnimationFrame(() => {
      const inst = handle.instance
      if (inst) inst.resize(inst.cols, inst.rows)
    })
  }, [viewportHeight, termRef])

  const readyRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
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
      everConnectedRef.current = false
      hadErrorRef.current = false
      permanentErrorRef.current = false
      readyRef.current = false
    }
  }, [])

  const handleReady = useCallback(() => {
    if (readyRef.current) return
    readyRef.current = true
    connect()
  }, [connect])

  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    function onPaste(e: ClipboardEvent) {
      const text = e.clipboardData?.getData("text/plain")
      if (text) {
        e.preventDefault()
        sendInput(text)
      }
    }
    el.addEventListener("paste", onPaste)
    return () => el.removeEventListener("paste", onPaste)
  }, [sendInput])

  const handleResize = useCallback((cols: number, rows: number) => {
    sendResize(cols, rows)
  }, [sendResize])

  return (
    <div
      ref={wrapperRef}
      className="flex min-w-0 flex-col overflow-hidden"
      style={viewportHeight != null
        ? { height: viewportHeight, maxHeight: viewportHeight }
        : { height: "100%" }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 p-3">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg bg-card">
          <Terminal
            ref={termRef}
            autoResize
            cursorBlink
            onData={sendInput}
            onResize={handleResize}
            onReady={handleReady}
            className="absolute inset-0 bg-card p-1"
            style={{ height: "100%" }}
          />
          {connState !== "connected" && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]">
              <span className="text-sm text-muted-foreground">
                {connState === "unavailable"
                  ? "Terminal not available"
                  : connState === "reconnecting"
                    ? "Reconnecting..."
                    : connState === "error"
                      ? "Connection error"
                      : "Connecting..."}
              </span>
            </div>
          )}
        </div>
      </div>
      <TerminalToolbar termRef={termRef} onInput={sendInput} />
    </div>
  )
}
