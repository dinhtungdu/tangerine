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

  const showSpinner = isStreaming && !expanded

  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {showSpinner ? (
        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <span className={`transition-transform inline-block ${expanded ? "rotate-90" : ""}`}>▶</span>
      )}
      <span>
        {toolCount} tools
        {filesChanged > 0 && ` · ${filesChanged} files`}
        {" · "}
        {formatElapsed(duration)}
      </span>
    </button>
  )
}
