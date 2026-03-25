import { useEffect, useRef, useCallback } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"

interface TerminalPaneProps {
  taskId: string
}

export function TerminalPane({ taskId }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const backoffRef = useRef(1000)

  const connect = useCallback(() => {
    const term = termRef.current
    if (!term) return

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const url = `${protocol}//${window.location.host}/api/tasks/${taskId}/terminal`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      backoffRef.current = 1000
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
          // Send resize immediately so tmux gets the right size
          const fit = fitRef.current
          if (fit) {
            fit.fit()
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
          }
        } else if (msg.type === "output") {
          term.write(msg.data)
        } else if (msg.type === "exit") {
          term.writeln(`\r\n[Process exited with code ${msg.code}]`)
        } else if (msg.type === "error") {
          term.writeln(`\r\n[Error: ${msg.message}]`)
        }
      } catch {
        // Ignore unparseable
      }
    }

    ws.onclose = () => {
      wsRef.current = null
      const delay = backoffRef.current
      backoffRef.current = Math.min(delay * 2, 30000)
      reconnectTimerRef.current = setTimeout(connect, delay)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [taskId])

  useEffect(() => {
    if (!containerRef.current) return

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
    term.onData((data) => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }))
      }
    })

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

    return () => {
      resizeObserver.disconnect()
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      wsRef.current?.close()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [connect])

  return (
    <div className="flex h-full flex-col">
      <div ref={containerRef} className="min-h-0 flex-1 bg-surface-card p-1" />
    </div>
  )
}
