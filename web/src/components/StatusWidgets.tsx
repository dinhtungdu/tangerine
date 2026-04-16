import { useState, useEffect, useCallback, useRef } from "react"
import type { Task, SystemLogEntry } from "@tangerine/shared"
import { fetchSystemLogs, fetchOrphans, cleanupOrphans as apiCleanupOrphans, fetchUpdateStatus, updateProjectRepo, fetchHealth, type ProjectUpdateStatus } from "../lib/api"
import { formatRelativeTime, formatTimestamp } from "../lib/format"
import { Button } from "@/components/ui/button"

/* ── Cards ── */

export function ActiveRunsCard({ tasks }: { tasks: Task[] }) {
  const running = tasks.filter((t) => t.status === "running").length
  const queued = tasks.filter((t) => t.status === "created" || t.status === "provisioning").length
  const done = tasks.filter((t) => t.status === "done").length
  const [orphanCount, setOrphanCount] = useState(0)
  const [cleaning, setCleaning] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      const orphans = await fetchOrphans().catch(() => [])
      if (!cancelled) setOrphanCount(orphans.length)
    }
    poll()
    const interval = setInterval(poll, 10000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const handleCleanup = useCallback(async () => {
    setCleaning(true)
    try {
      const result = await apiCleanupOrphans()
      setOrphanCount((prev) => Math.max(0, prev - result.cleaned))
    } catch { /* ignore */ }
    setCleaning(false)
  }, [])

  return (
    <div className="flex flex-1 flex-col gap-2.5 rounded-[10px] border border-border p-3.5 md:gap-3 md:p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">Active Runs</span>
        <span className="rounded-xl bg-status-info-bg px-2.5 py-0.5 text-xxs font-semibold text-status-info-text">
          {running} Running
        </span>
      </div>
      <div className="flex gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-2xl font-bold text-foreground md:text-3xl">{running}</span>
          <span className="text-xxs font-medium text-status-info md:text-xs">Running</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-2xl font-bold text-foreground md:text-3xl">{queued}</span>
          <span className="text-xxs font-medium text-status-warning md:text-xs">Queued</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-2xl font-bold text-foreground md:text-3xl">{done}</span>
          <span className="text-xxs font-medium text-status-success md:text-xs">Completed</span>
        </div>
      </div>
      {orphanCount > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-status-warning-bg px-3 py-2">
          <span className="text-xs font-medium text-status-warning-text">
            {orphanCount} orphaned worktree{orphanCount !== 1 ? "s" : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCleanup}
            disabled={cleaning}
          >
            {cleaning ? "Cleaning…" : "Clean up"}
          </Button>
        </div>
      )}
    </div>
  )
}

/* ── Log level badge ── */

const LOG_CONTEXT_SKIP_KEYS = new Set(["taskId"])

function LogContext({ context }: { context: Record<string, unknown> }) {
  const entries = Object.entries(context).filter(([k]) => !LOG_CONTEXT_SKIP_KEYS.has(k))
  if (entries.length === 0) return null
  return (
    <span className="mt-0.5 block break-all font-mono text-xs text-muted-foreground">
      {entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 && " "}
          <span className="text-muted-foreground/50">{k}=</span>
          {String(v)}
        </span>
      ))}
    </span>
  )
}

function LogLevelBadge({ level }: { level: string }) {
  const styles: Record<string, { color: string; bg: string }> = {
    debug: { color: "var(--color-muted-foreground)", bg: "var(--color-muted)" },
    info:  { color: "var(--color-status-info-text)", bg: "var(--color-status-info-bg)" },
    warn:  { color: "var(--color-status-warning-text)", bg: "var(--color-status-warning-bg)" },
    error: { color: "var(--color-status-error-text)", bg: "var(--color-status-error-bg)" },
  }
  const fallback = { color: "var(--color-status-info-text)", bg: "var(--color-status-info-bg)" }
  const s = styles[level] ?? fallback
  return (
    <span className="rounded px-1.5 py-0.5 text-2xs font-semibold uppercase" style={{ color: s.color, backgroundColor: s.bg }}>
      {level}
    </span>
  )
}

/* ── Project Update Card ── */

export function ProjectUpdateCard({ project }: { project?: string }) {
  const [status, setStatus] = useState<ProjectUpdateStatus | null>(null)
  const [updating, setUpdating] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    if (!project) return
    let cancelled = false
    async function poll() {
      const s = await fetchUpdateStatus(project!).catch(() => null)
      if (!cancelled) setStatus(s)
    }
    poll()
    const interval = setInterval(poll, 30_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [project])

  const handleUpdate = useCallback(async () => {
    if (!project || updating) return
    setUpdating(true)
    setResult(null)
    try {
      const res = await updateProjectRepo(project)
      if (res.restart) {
        setResult("Server restarting\u2026")
        setUpdating(false)
        // Poll until the server is back online, then clear the banner
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 2000))
          try {
            await fetchHealth()
            setResult(null)
            break
          } catch { /* still restarting */ }
        }
        return
      } else if (res.updated) {
        setResult(`Updated ${res.from} \u2192 ${res.to}`)
      } else {
        setResult("Already up to date")
      }
      const s = await fetchUpdateStatus(project).catch(() => null)
      setStatus(s)
    } catch (e) {
      setResult(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    setUpdating(false)
  }, [project, updating])

  return (
    <div className="flex flex-1 flex-col gap-2.5 rounded-[10px] border border-border p-3.5 md:gap-3 md:p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">Repository</span>
          {status?.isFork && (
            <span className="rounded-xl bg-muted px-2 py-0.5 text-xxs font-medium text-muted-foreground">
              Fork
            </span>
          )}
        </div>
        {status?.available && (
          <span className="rounded-xl bg-status-info-bg px-2.5 py-0.5 text-xxs font-semibold text-status-info-text">
            Update available
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {status?.local && (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-sm font-medium text-foreground">{status.local}</span>
            <span className="text-xxs text-muted-foreground">Current</span>
          </div>
        )}
        {status?.available && status.remote && (
          <>
            <svg className="h-3.5 w-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
            </svg>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-sm font-medium text-status-info">{status.remote}</span>
              <span className="text-xxs text-muted-foreground">Latest</span>
            </div>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleUpdate}
            disabled={updating}
          >
            {updating ? (
              <>
                <svg data-icon="inline-start" className="animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Updating...
              </>
            ) : (
              <>
                <svg data-icon="inline-start" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.992 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
                </svg>
                Pull latest
              </>
            )}
          </Button>
        </div>
      </div>

      {result && (
        <div className={`rounded-lg px-3 py-2 text-xs font-medium ${
          result.startsWith("Failed")
            ? "bg-status-error-bg text-status-error-text"
            : result.startsWith("Server")
              ? "bg-status-warning-bg text-status-warning-text"
              : "bg-status-success-bg text-status-success-text"
        }`}>
          {result}
        </div>
      )}

      {status?.checkedAt && (
        <span className="text-xxs text-muted-foreground/50">
          Last checked {formatRelativeTime(status.checkedAt)}
        </span>
      )}
    </div>
  )
}

/* ── Filter pills ── */

const LOG_FILTERS: Array<{ label: string; value: string[] | null; level?: string[] }> = [
  { label: "All", value: null },
  { label: "Errors", value: null, level: ["error"] },
]

/** Use shared formatTimestamp for consistent local-timezone display */
const formatLogTimestamp = formatTimestamp

/* ── System Log ── */

const MAX_LOG_ENTRIES = 200

export function SystemLog({ project }: { project?: string }) {
  const [logs, setLogs] = useState<SystemLogEntry[]>([])
  const [activeFilter, setActiveFilter] = useState(0)
  const latestTimestampRef = useRef<string | undefined>(undefined)

  const fetchLogs = useCallback(async (since?: string) => {
    const filter = LOG_FILTERS[activeFilter]!
    const params: { level?: string[]; logger?: string[]; project?: string; limit?: number; since?: string } = {
      limit: since ? 50 : MAX_LOG_ENTRIES,
      project,
    }
    if (filter.level) params.level = [...filter.level]
    if (filter.value) params.logger = [...filter.value]
    if (since) params.since = since

    const data = await fetchSystemLogs(params).catch(() => [] as SystemLogEntry[])

    if (!since) {
      // Initial load: replace state and record newest timestamp
      setLogs(data)
      latestTimestampRef.current = data[0]?.timestamp
    } else if (data.length > 0) {
      // Incremental: prepend new entries (API returns DESC so data[0] is newest)
      setLogs((prev) => {
        const existingIds = new Set(prev.map((l) => l.id))
        const fresh = data.filter((l) => !existingIds.has(l.id))
        if (fresh.length === 0) return prev
        return [...fresh, ...prev].slice(0, MAX_LOG_ENTRIES)
      })
      latestTimestampRef.current = data[0]?.timestamp
    }
  }, [activeFilter, project])

  useEffect(() => {
    latestTimestampRef.current = undefined
    fetchLogs()
    const interval = setInterval(() => fetchLogs(latestTimestampRef.current), 5000)
    return () => clearInterval(interval)
  }, [fetchLogs])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sub font-semibold text-foreground md:text-base">System Log</span>
        <span className="rounded-xl bg-muted px-2.5 py-0.5 text-xxs font-semibold text-muted-foreground">
          {logs.length} entries
        </span>
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap gap-1.5">
        {LOG_FILTERS.map((f, i) => (
          <button
            key={f.label}
            onClick={() => setActiveFilter(i)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/50 ${
              i === activeFilter
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {logs.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground/50">No system logs yet</div>
      ) : (
        <div className="max-h-[400px] overflow-x-hidden overflow-y-auto rounded-lg border border-border">
          {/* Desktop: table with task context */}
          <div className="hidden md:block">
            <div className="grid grid-cols-[100px_50px_80px_80px_1fr] bg-muted px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground">Time</span>
              <span className="text-xs font-medium text-muted-foreground">Level</span>
              <span className="text-xs font-medium text-muted-foreground">Source</span>
              <span className="text-xs font-medium text-muted-foreground">Task</span>
              <span className="text-xs font-medium text-muted-foreground">Message</span>
            </div>
            {logs.map((log) => {
              const ctx = log.context as Record<string, string> | null
              const taskId = ctx?.taskId ? String(ctx.taskId).slice(0, 8) : ""
              return (
                <div key={log.id} className="grid grid-cols-[100px_50px_80px_80px_1fr] items-center border-t border-border px-3 py-2">
                  <span className="font-mono text-xxs text-muted-foreground">{formatLogTimestamp(log.timestamp)}</span>
                  <div><LogLevelBadge level={log.level} /></div>
                  <span className="truncate text-xs font-medium text-muted-foreground">{log.logger}</span>
                  <span className="truncate font-mono text-xxs text-muted-foreground/50">{taskId}</span>
                  <span className="min-w-0 overflow-hidden font-mono text-xs text-foreground">
                    <span className="truncate">{log.message}</span>
                    {ctx && <LogContext context={ctx} />}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Mobile: two-row cards */}
          <div className="flex flex-col md:hidden">
            {logs.map((log) => {
              const ctx = log.context as Record<string, string> | null
              const taskId = ctx?.taskId ? String(ctx.taskId).slice(0, 8) : ""
              return (
                <div key={log.id} className="flex flex-col gap-0.5 border-b border-border px-3 py-2 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-2xs text-muted-foreground">{formatLogTimestamp(log.timestamp)}</span>
                    <LogLevelBadge level={log.level} />
                    <span className="text-xxs font-medium text-muted-foreground">{log.logger}</span>
                    {taskId && <span className="font-mono text-2xs text-muted-foreground/50">{taskId}</span>}
                  </div>
                  <span className="block break-words font-mono text-xs text-foreground">{log.message}</span>
                  {ctx && <LogContext context={ctx} />}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
