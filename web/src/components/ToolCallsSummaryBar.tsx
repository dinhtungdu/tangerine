import { useState, useEffect } from "react"

interface ToolCallsSummaryBarProps {
  isStreaming: boolean
  startTime: string
  toolCount: number
  filesChanged: number
  expanded: boolean
  onToggle: () => void
}

function useElapsedTime(startTime: string, active: boolean): number {
  const [elapsed, setElapsed] = useState(() => {
    const start = new Date(startTime).getTime()
    return Math.floor((Date.now() - start) / 1000)
  })

  useEffect(() => {
    if (!active) return
    const start = new Date(startTime).getTime()
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [startTime, active])

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
  toolCount,
  filesChanged,
  expanded,
  onToggle,
}: ToolCallsSummaryBarProps) {
  const elapsed = useElapsedTime(startTime, isStreaming)

  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <svg
        className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
      <span>{toolCount} tool calls</span>
      {filesChanged > 0 && <span>· {filesChanged} files</span>}
      <span>· {formatElapsed(elapsed)}</span>
    </button>
  )
}
