import { useState, useEffect } from "react"

interface ToolCallsSummaryBarProps {
  isStreaming: boolean
  startTime: string
  endTime?: string
  toolCount: number
  filesChanged: number
  expanded: boolean
  onToggle: () => void
}

function useDuration(startTime: string, endTime: string | undefined, isStreaming: boolean): number {
  const [elapsed, setElapsed] = useState(() => {
    const start = new Date(startTime).getTime()
    if (!isStreaming && endTime) {
      return Math.max(0, Math.floor((new Date(endTime).getTime() - start) / 1000))
    }
    return Math.floor((Date.now() - start) / 1000)
  })

  useEffect(() => {
    // For completed turns, compute fixed duration
    if (!isStreaming && endTime) {
      const start = new Date(startTime).getTime()
      const end = new Date(endTime).getTime()
      setElapsed(Math.max(0, Math.floor((end - start) / 1000)))
      return
    }
    // For streaming, tick live
    const start = new Date(startTime).getTime()
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [startTime, endTime, isStreaming])

  return elapsed
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

export function ToolCallsSummaryBar({
  isStreaming,
  startTime,
  endTime,
  toolCount,
  filesChanged,
  expanded,
  onToggle,
}: ToolCallsSummaryBarProps) {
  const duration = useDuration(startTime, endTime, isStreaming)

  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <span className={`transition-transform inline-block ${expanded ? "rotate-90" : ""}`}>▶</span>
      <span>
        {toolCount} tools
        {filesChanged > 0 && ` · ${filesChanged} files`}
        {" · "}
        {formatElapsed(duration)}
      </span>
    </button>
  )
}
