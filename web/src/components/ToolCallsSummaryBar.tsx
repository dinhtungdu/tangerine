import { useState, useEffect } from "react"

interface ToolCallsSummaryBarProps {
  isStreaming: boolean
  startTime: string
  toolCount: number
  filesChanged: number
  hasError: boolean
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
  hasError,
  expanded,
  onToggle,
}: ToolCallsSummaryBarProps) {
  const elapsed = useElapsedTime(startTime, isStreaming)

  const statusWord = isStreaming ? "Pondering..." : "Crafted"
  const statusColor = hasError
    ? "text-status-error"
    : isStreaming
      ? "text-amber-500"
      : "text-muted-foreground"

  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex w-full items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-left outline-none transition-colors hover:bg-muted/80 focus-visible:ring-1 focus-visible:ring-ring/50"
    >
      {/* Status indicator */}
      {isStreaming ? (
        <svg className="h-3 w-3 animate-spin text-amber-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : hasError ? (
        <span className="h-2 w-2 rounded-full bg-status-error" />
      ) : (
        <span className="h-2 w-2 rounded-full bg-status-success" />
      )}

      {/* Status word */}
      <span className={`text-xs font-medium ${statusColor}`}>{statusWord}</span>

      <span className="text-muted-foreground/50">·</span>

      {/* Timer */}
      <span className="text-xs text-muted-foreground">{formatElapsed(elapsed)}</span>

      <span className="text-muted-foreground/50">·</span>

      {/* Tool count */}
      <span className="text-xs text-muted-foreground">
        {toolCount} tool call{toolCount !== 1 ? "s" : ""}
      </span>

      {/* Files changed (if any) */}
      {filesChanged > 0 && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span className="text-xs text-muted-foreground">
            {filesChanged} file{filesChanged !== 1 ? "s" : ""} changed
          </span>
        </>
      )}

      {/* Expand/collapse indicator */}
      <span className="ml-auto text-muted-foreground">
        <svg
          className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </span>
    </button>
  )
}
