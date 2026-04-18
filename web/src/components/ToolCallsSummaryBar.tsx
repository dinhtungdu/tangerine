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
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <span className={`transition-transform inline-block ${expanded ? "rotate-90" : ""}`}>▶</span>
      <span>
        {toolCount} tools
        {filesChanged > 0 && ` · ${filesChanged} files`}
        {" · "}
        {formatElapsed(elapsed)}
      </span>
    </button>
  )
}
