import { useState, useEffect } from "react"
import { ChevronRight, Loader2 } from "lucide-react"

interface ToolCallsSummaryBarProps {
  isStreaming: boolean
  startTime: string
  endTime?: string
  toolCount: number
  filesChanged: number
  errorCount: number
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
  errorCount,
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
      <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
      <span>
        {toolCount} tools
        {filesChanged > 0 && ` · ${filesChanged} files`}
        {errorCount > 0 && <span className="text-destructive"> · {errorCount} {errorCount === 1 ? "error" : "errors"}</span>}
        {" · "}
        {formatElapsed(duration)}
      </span>
      {showSpinner && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
    </button>
  )
}
