import { useEffect, useRef, useCallback, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"
import { TerminalToolbar } from "./TerminalToolbar"
import { emitAuthFailure, getAuthToken } from "../lib/auth"

type TerminalPaneProps =
  | { taskId: string; wsUrl?: never }
  | { taskId?: never; wsUrl: string }

type ConnState = "connecting" | "connected" | "reconnecting" | "error"

export function TerminalPane(props: TerminalPaneProps) {
  const wsPath = props.wsUrl ?? `/api/tasks/${props.taskId}/terminal`
  const wrapperRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const backoffRef = useRef(1000)
  const disposedRef = useRef(false)
  const everConnectedRef = useRef(false)
  const hadErrorRef = useRef(false)
  const [connState, setConnState] = useState<ConnState>("connecting")

  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }))
    }
  }, [])

  const connect = useCallback(() => {
    const term = termRef.current
    if (!term || disposedRef.current) return
    hadErrorRef.current = false

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const url = `${protocol}//${window.location.host}${wsPath}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      backoffRef.current = 1000
      const token = getAuthToken()
      if (token) {
        ws.send(JSON.stringify({ type: "auth", token }))
      }
      // Send initial size after a tick so the container is measured
      requestAnimationFrame(() => {
        const fit = fitRef.current
        if (fit) {
          fit.fit()
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
        }
      })
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string)
        if (msg.type === "connected") {
          everConnectedRef.current = true
          setConnState("connected")
          // Send resize immediately so dtach gets the right size
          const fit = fitRef.current
          if (fit) {
            fit.fit()
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
          }
        } else if (msg.type === "scrollback") {
          // Clear terminal before writing scrollback to avoid duplicating on reconnect
          term.clear()
          term.write(msg.data)
        } else if (msg.type === "output") {
          term.write(msg.data)
        } else if (msg.type === "exit") {
          term.writeln(`\r\n[Process exited with code ${msg.code}]`)
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
      // Only handle reconnect if this is still the active WebSocket
      if (wsRef.current !== ws) return
      wsRef.current = null
      if (disposedRef.current) return
      const delay = backoffRef.current
      backoffRef.current = Math.min(delay * 2, 5000)
      if (hadErrorRef.current) {
        // Hold "error" visible for 2s before retrying so the user can read it
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

  // Track visual viewport height to handle mobile keyboard overlap.
  // When the virtual keyboard opens, visualViewport.height shrinks — we use
  // this to constrain the container so the toolbar stays visible and the
  // terminal re-fits to the smaller area.
  const [viewportHeight, setViewportHeight] = useState<number | null>(null)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    function onResize() {
      const vv = window.visualViewport!
      // Only constrain when the keyboard is likely open (viewport noticeably shorter than window)
      if (window.innerHeight - vv.height > 100) {
        // Subtract the element's top offset so the terminal doesn't extend behind the keyboard
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
      // Trigger terminal re-fit
      fitRef.current?.fit()
    }

    vv.addEventListener("resize", onResize)
    return () => vv.removeEventListener("resize", onResize)
  }, [])

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

    // Forward keyboard input to WebSocket
    term.onData(sendInput)

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
      }
    })
    resizeObserver.observe(containerRef.current)

    connect()

    // Reconnect immediately when returning from background (iOS Safari)
    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return
      if (!wsRef.current || wsRef.current.readyState >= WebSocket.CLOSING) {
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = null
        }
        backoffRef.current = 1000
        setConnState(everConnectedRef.current ? "reconnecting" : "connecting")
        connect()
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      disposedRef.current = true
      document.removeEventListener("visibilitychange", onVisibilityChange)
      resizeObserver.disconnect()
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      const ws = wsRef.current
      if (ws) {
        // Null handlers before close so reconnect logic doesn't fire.
        // Close immediately regardless of readyState — deferring to onopen
        // would suppress the browser warning but let the handshake complete,
        // which can create orphaned server sessions on slow networks.
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
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [connect])

  return (
    <div
      ref={wrapperRef}
      className="flex flex-col overflow-hidden"
      style={viewportHeight != null
        ? { height: viewportHeight, maxHeight: viewportHeight }
        : { height: "100%" }}
    >
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0 bg-card p-1" />
        {connState !== "connected" && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]">
            <span className="text-sm text-muted-foreground">
              {connState === "reconnecting" ? "Reconnecting..." : connState === "error" ? "Connection error" : "Connecting..."}
            </span>
          </div>
        )}
      </div>
      <TerminalToolbar termRef={termRef} onInput={sendInput} />
    </div>
  )
}
