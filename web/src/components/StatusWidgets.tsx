import { useState, useEffect, useCallback } from "react"
import type { Task, SystemLogEntry } from "@tangerine/shared"
import { fetchSystemLogs, fetchOrphans, cleanupOrphans as apiCleanupOrphans, fetchUpdateStatus, updateProjectRepo, fetchHealth, type ProjectUpdateStatus } from "../lib/api"
import { formatRelativeTime } from "../lib/format"

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
    <div className="flex flex-1 flex-col gap-2.5 rounded-[10px] border border-edge p-3.5 md:gap-3 md:p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-fg-muted">Active Runs</span>
        <span className="rounded-xl bg-status-info-bg px-2.5 py-0.5 text-[11px] font-semibold text-status-info-text">
          {running} Running
        </span>
      </div>
      <div className="flex gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[24px] font-bold text-fg md:text-[28px]">{running}</span>
          <span className="text-[11px] font-medium text-status-info md:text-[12px]">Running</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[24px] font-bold text-fg md:text-[28px]">{queued}</span>
          <span className="text-[11px] font-medium text-status-warning md:text-[12px]">Queued</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[24px] font-bold text-fg md:text-[28px]">{done}</span>
          <span className="text-[11px] font-medium text-status-success md:text-[12px]">Completed</span>
        </div>
      </div>
      {orphanCount > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-status-warning-bg px-3 py-2">
          <span className="text-[12px] font-medium text-status-warning-text">
            {orphanCount} orphaned worktree{orphanCount !== 1 ? "s" : ""}
          </span>
          <button
            onClick={handleCleanup}
            disabled={cleaning}
            className="flex items-center gap-1 rounded-md bg-status-warning-text px-2 py-0.5 text-[11px] font-medium text-white disabled:opacity-50"
          >
            {cleaning ? "Cleaning…" : "Clean up"}
          </button>
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
    <span className="ml-1.5 text-fg-muted">
      {entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 && " "}
          <span className="text-fg-faint">{k}=</span>
          {String(v)}
        </span>
      ))}
    </span>
  )
}

function LogLevelBadge({ level }: { level: string }) {
  const styles: Record<string, { color: string; bg: string }> = {
    debug: { color: "var(--color-fg-muted)", bg: "var(--color-surface-secondary)" },
    info:  { color: "var(--color-status-info-text)", bg: "var(--color-status-info-bg)" },
    warn:  { color: "var(--color-status-warning-text)", bg: "var(--color-status-warning-bg)" },
    error: { color: "var(--color-status-error-text)", bg: "var(--color-status-error-bg)" },
  }
  const fallback = { color: "var(--color-status-info-text)", bg: "var(--color-status-info-bg)" }
  const s = styles[level] ?? fallback
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase" style={{ color: s.color, backgroundColor: s.bg }}>
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
    <div className="flex flex-1 flex-col gap-2.5 rounded-[10px] border border-edge p-3.5 md:gap-3 md:p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-fg-muted">Repository</span>
        {status?.available && (
          <span className="rounded-xl bg-status-info-bg px-2.5 py-0.5 text-[11px] font-semibold text-status-info-text">
            Update available
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {status?.local && (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[13px] font-medium text-fg">{status.local}</span>
            <span className="text-[11px] text-fg-muted">Current</span>
          </div>
        )}
        {status?.available && status.remote && (
          <>
            <svg className="h-3.5 w-3.5 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
            </svg>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[13px] font-medium text-status-info">{status.remote}</span>
              <span className="text-[11px] text-fg-muted">Latest</span>
            </div>
          </>
        )}
        <div className="ml-auto">
          <button
            onClick={handleUpdate}
            disabled={updating}
            className="flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-[12px] font-medium text-fg transition hover:bg-surface-secondary active:bg-surface-secondary disabled:opacity-50"
          >
            {updating ? (
              <>
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Updating...
              </>
            ) : (
              <>
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.992 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
                </svg>
                Pull latest
              </>
            )}
          </button>
        </div>
      </div>

      {result && (
        <div className={`rounded-lg px-3 py-2 text-[12px] font-medium ${
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
        <span className="text-[11px] text-fg-faint">
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

function formatLogTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

/* ── System Log ── */

export function SystemLog({ project }: { project?: string }) {
  const [logs, setLogs] = useState<SystemLogEntry[]>([])
  const [activeFilter, setActiveFilter] = useState(0)

  const loadLogs = useCallback(async () => {
    const filter = LOG_FILTERS[activeFilter]!
    const params: { level?: string[]; logger?: string[]; project?: string; limit?: number } = { limit: 500, project }
    if (filter.level) params.level = [...filter.level]
    if (filter.value) params.logger = [...filter.value]
    const data = await fetchSystemLogs(params).catch(() => [])
    setLogs(data)
  }, [activeFilter, project])

  useEffect(() => {
    loadLogs()
    const interval = setInterval(loadLogs, 5000)
    return () => clearInterval(interval)
  }, [loadLogs])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold text-fg md:text-[16px]">System Log</span>
        <span className="rounded-xl bg-surface-secondary px-2.5 py-0.5 text-[11px] font-semibold text-fg-muted">
          {logs.length} entries
        </span>
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap gap-1.5">
        {LOG_FILTERS.map((f, i) => (
          <button
            key={f.label}
            onClick={() => setActiveFilter(i)}
            className={`rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors ${
              i === activeFilter
                ? "bg-fg text-bg"
                : "bg-surface-secondary text-fg-muted hover:text-fg"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {logs.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-fg-faint">No system logs yet</div>
      ) : (
        <div className="max-h-[400px] overflow-y-auto rounded-lg border border-edge">
          {/* Desktop: table with task context */}
          <div className="hidden md:block">
            <div className="grid grid-cols-[100px_50px_80px_80px_1fr] bg-surface-secondary px-3 py-2">
              <span className="text-[12px] font-medium text-fg-muted">Time</span>
              <span className="text-[12px] font-medium text-fg-muted">Level</span>
              <span className="text-[12px] font-medium text-fg-muted">Source</span>
              <span className="text-[12px] font-medium text-fg-muted">Task</span>
              <span className="text-[12px] font-medium text-fg-muted">Message</span>
            </div>
            {logs.map((log) => {
              const ctx = log.context as Record<string, string> | null
              const taskId = ctx?.taskId ? String(ctx.taskId).slice(0, 8) : ""
              return (
                <div key={log.id} className="grid grid-cols-[100px_50px_80px_80px_1fr] items-center border-t border-edge px-3 py-2">
                  <span className="font-mono text-[11px] text-fg-muted">{formatLogTimestamp(log.timestamp)}</span>
                  <div><LogLevelBadge level={log.level} /></div>
                  <span className="truncate text-[12px] font-medium text-fg-muted">{log.logger}</span>
                  <span className="truncate font-mono text-[11px] text-fg-faint">{taskId}</span>
                  <span className="min-w-0 text-[12px] text-fg">
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
                <div key={log.id} className="flex flex-col gap-0.5 border-b border-edge px-3 py-2 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-fg-muted">{formatLogTimestamp(log.timestamp)}</span>
                    <LogLevelBadge level={log.level} />
                    <span className="text-[11px] font-medium text-fg-muted">{log.logger}</span>
                    {taskId && <span className="font-mono text-[10px] text-fg-faint">{taskId}</span>}
                  </div>
                  <span className="text-[12px] text-fg">{log.message}</span>
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
