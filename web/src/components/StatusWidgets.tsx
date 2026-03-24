import { useState, useEffect, useCallback, useRef } from "react"
import type { Task, SystemLogEntry } from "@tangerine/shared"
import { fetchSystemLogs, fetchBuildLog, fetchOrphans, cleanupOrphans as apiCleanupOrphans, type VmInfo, type ImageInfo, type BuildStatus } from "../lib/api"
import { formatRelativeTime } from "../lib/format"

/* ── Status badge ── */

export function StatusBadge({ status }: { status: string }) {
  const badges: Record<string, { label: string; color: string; bg: string }> = {
    ready:        { label: "Ready",        color: "var(--color-status-success-text)", bg: "var(--color-status-success-bg)" },
    assigned:     { label: "Assigned",     color: "var(--color-status-info-text)", bg: "var(--color-status-info-bg)" },
    provisioning: { label: "Provisioning", color: "var(--color-status-warning-text)", bg: "var(--color-status-warning-bg)" },
    destroying:   { label: "Destroying",   color: "var(--color-fg-muted)", bg: "var(--color-surface-secondary)" },
    error:        { label: "Error",        color: "var(--color-status-error-text)", bg: "var(--color-status-error-bg)" },
  }
  const b = badges[status] ?? { label: status, color: "var(--color-fg-muted)", bg: "var(--color-surface-secondary)" }
  return (
    <span className="rounded-xl px-2 py-0.5 text-[11px] font-medium" style={{ color: b.color, backgroundColor: b.bg }}>
      {b.label}
    </span>
  )
}

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
          <span className="text-[11px] font-medium text-status-success md:text-[12px]">Done</span>
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

export function VmSummaryCard({ vms, onRebuildVm, onProvisionVm }: { vms: VmInfo[]; onRebuildVm: (vmId: string) => void; onProvisionVm: () => void }) {
  const vm = vms[0]
  const status = vm?.status ?? "none"
  const isActive = status === "active" || status === "ready" || status === "assigned"
  const isProvisioning = status === "provisioning"

  const isError = status === "error"

  const badge = isActive
    ? { label: "Active", cls: "bg-status-success-bg text-status-success-text" }
    : isProvisioning
      ? { label: "Provisioning", cls: "bg-status-warning-bg text-status-warning-text" }
      : isError
        ? { label: "Error", cls: "bg-status-error-bg text-status-error-text" }
        : vm
          ? { label: "Stopped", cls: "bg-surface-secondary text-fg-muted" }
          : { label: "No VM", cls: "bg-surface-secondary text-fg-muted" }

  return (
    <div className="flex flex-1 flex-col gap-2.5 rounded-[10px] border border-edge p-3.5 md:gap-3 md:p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-fg-muted">Project VM</span>
        <span className={`rounded-xl px-2.5 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      {vm ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[15px] font-semibold text-fg">{vm.id}</span>
            <span className="text-[12px] text-fg-muted">{vm.ip ?? "No IP"}</span>
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => onRebuildVm(vm.id)}
              className="flex items-center gap-1.5 rounded-md bg-surface-secondary px-3 py-1 text-[12px] font-medium text-fg-muted hover:text-fg"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
              </svg>
              Rebuild VM
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-fg-muted">No VM provisioned yet.</p>
          <div className="flex md:justify-end">
            <button
              onClick={onProvisionVm}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-fg px-3.5 py-1.5 text-[13px] font-medium text-bg md:w-auto"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7" />
              </svg>
              Provision VM
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function ImageCard({ image, projectImage, buildStatus, onBuildBase }: {
  image: ImageInfo | null
  projectImage?: string
  buildStatus: BuildStatus
  onBuildBase: () => void
}) {
  const isBuilding = buildStatus.status === "building"
  const isFailed = buildStatus.status === "failed"
  const built = !!image || buildStatus.status === "success"

  // Badge state
  const badge = isBuilding
    ? { label: "Building…", color: "var(--color-status-info-text)", bg: "var(--color-status-info-bg)", icon: true }
    : isFailed
      ? { label: "Failed", color: "var(--color-status-error-text)", bg: "var(--color-status-error-bg)", icon: false }
      : built
        ? { label: "Built", color: "var(--color-status-success-text)", bg: "var(--color-status-success-bg)", icon: false }
        : { label: "Not Built", color: "#a16207", bg: "#fefce8", icon: false }

  return (
    <div className="flex flex-1 flex-col gap-2.5 rounded-[10px] border border-edge p-3.5 md:gap-3 md:p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-fg-muted">Base Image</span>
        <span className="flex items-center gap-1.5 rounded-xl px-2.5 py-0.5 text-[11px] font-semibold" style={{ color: badge.color, backgroundColor: badge.bg }}>
          {badge.icon && (
            <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" d="M12 2a10 10 0 0 1 10 10" />
            </svg>
          )}
          {badge.label}
        </span>
      </div>

      {/* Body — varies by state */}
      {isBuilding ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <svg className="h-3.5 w-3.5 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
            </svg>
            <span className="text-[13px] font-medium text-fg">{buildStatus.imageName ?? projectImage}</span>
          </div>
          <span className="text-[12px] text-fg-muted">Running build…</span>
          {buildStatus.startedAt && (
            <span className="text-[11px] text-fg-faint">Started {formatRelativeTime(buildStatus.startedAt)}</span>
          )}
        </div>
      ) : isFailed ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <svg className="h-3.5 w-3.5 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
            </svg>
            <span className="text-[13px] font-medium text-fg">{buildStatus.imageName ?? projectImage}</span>
          </div>
          {buildStatus.error && (
            <span className="text-[12px] text-status-error">{buildStatus.error}</span>
          )}
          <div className="flex justify-end md:justify-end">
            <button onClick={onBuildBase} className="flex items-center gap-1.5 rounded-md bg-fg px-3.5 py-1.5 text-[13px] font-medium text-bg">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
              </svg>
              Retry
            </button>
          </div>
        </div>
      ) : built ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <svg className="h-3.5 w-3.5 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
              </svg>
              <span className="text-[13px] font-medium text-fg">{image?.name ?? "tangerine-base"}</span>
            </div>
            {image && <span className="text-[12px] text-fg-muted">{image.snapshotId.slice(0, 9)} · {formatRelativeTime(image.createdAt)}</span>}
          </div>
          <div className="flex justify-end">
            <button onClick={onBuildBase} disabled={isBuilding} className="flex items-center gap-1.5 rounded-md bg-surface-secondary px-3 py-1 text-[12px] font-medium text-fg-muted hover:text-fg disabled:opacity-50">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
              </svg>
              Rebuild Base
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[13px] text-fg-muted">tangerine-base</span>
            <span className="text-[12px] text-fg-faint">No base image yet. Build one to start provisioning project VMs.</span>
          </div>
          <div className="flex md:justify-end">
            <button onClick={onBuildBase} className="flex w-full items-center justify-center gap-1.5 rounded-md bg-fg px-3.5 py-1.5 text-[13px] font-medium text-bg md:w-auto">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085" />
              </svg>
              Build Base
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── VM Table (desktop) / VM Cards (mobile) ── */

export function VmList({ vms }: { vms: VmInfo[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold text-fg md:text-[16px]">Virtual Machines</span>
        <span className="rounded-xl bg-surface-secondary px-2.5 py-0.5 text-[11px] font-semibold text-fg-muted">
          {vms.length} VMs
        </span>
      </div>

      {vms.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-fg-faint">No VMs in pool</div>
      ) : (
        <>
          {/* Desktop: table */}
          <div className="hidden overflow-hidden rounded-lg border border-edge md:block">
            <div className="grid grid-cols-[minmax(120px,1fr)_80px_100px_minmax(120px,2fr)_100px] bg-surface-secondary px-3 py-2.5">
              <span className="text-[12px] font-medium text-fg-muted">ID</span>
              <span className="text-[12px] font-medium text-fg-muted">Status</span>
              <span className="text-[12px] font-medium text-fg-muted">IP</span>
              <span className="text-[12px] font-medium text-fg-muted">Task</span>
              <span className="text-[12px] font-medium text-fg-muted">Created</span>
            </div>
            {vms.map((vm) => (
              <div key={vm.id} className="grid grid-cols-[minmax(120px,1fr)_80px_100px_minmax(120px,2fr)_100px] items-center border-t border-edge px-3 py-2.5">
                <span className="truncate font-mono text-[12px] text-fg">{vm.id.slice(0, 12)}</span>
                <div><StatusBadge status={vm.status} /></div>
                <span className="truncate font-mono text-[12px] text-fg">{vm.ip ?? "—"}</span>
                <span className={`truncate text-[13px] ${vm.taskId ? "font-medium text-fg" : "text-fg-muted"}`} title={vm.taskId ?? undefined}>
                  {vm.taskTitle ?? (vm.taskId ? vm.taskId.slice(0, 8) : "—")}
                </span>
                <span className="truncate text-[13px] text-fg-muted">{formatRelativeTime(vm.createdAt)}</span>
              </div>
            ))}
          </div>

          {/* Mobile: cards */}
          <div className="flex flex-col gap-2.5 md:hidden">
            {vms.map((vm) => (
              <div key={vm.id} className="flex flex-col gap-1.5 rounded-lg border border-edge p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[12px] text-fg">{vm.id.slice(0, 12)}</span>
                  <StatusBadge status={vm.status} />
                </div>
                <div className="flex gap-3 text-[11px] text-fg-muted">
                  <span className="font-mono">{vm.ip ?? "—"}</span>
                  <span>{vm.taskTitle ?? (vm.taskId ? vm.taskId.slice(0, 8) : "No task")}</span>
                  <span>{formatRelativeTime(vm.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/* ── Build Log (standalone section) ── */

export function BuildLog({ project, buildStatus }: { project?: string; buildStatus: BuildStatus }) {
  const [log, setLog] = useState("")
  const [open, setOpen] = useState(false)
  const scrollRef = useRef<HTMLPreElement>(null)
  const hasLog = buildStatus.status !== "idle"

  // Auto-open when building starts
  useEffect(() => {
    if (buildStatus.status === "building") setOpen(true)
  }, [buildStatus.status])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function poll() {
      const data = await fetchBuildLog(project).catch(() => null)
      if (cancelled || !data) return
      setLog(data.content)
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [open, project])

  if (!hasLog) return null

  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 self-start"
      >
        <svg className={`h-3.5 w-3.5 text-fg-muted transition-transform ${open ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
        <span className="text-[15px] font-semibold text-fg md:text-[16px]">Build Log</span>
        {buildStatus.status === "building" && (
          <span className="rounded-xl bg-status-info-bg px-2.5 py-0.5 text-[11px] font-semibold text-status-info-text">
            Live
          </span>
        )}
      </button>
      {open && (
        <pre
          ref={scrollRef}
          className="max-h-[400px] overflow-auto rounded-lg border border-edge bg-[#1a1a1a] p-4 font-mono text-[12px] leading-[1.6] text-[#d4d4d4]"
        >
          {log || "No build log available"}
        </pre>
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

/* ── Filter pills ── */

const LOG_FILTERS: Array<{ label: string; value: string[] | null; level?: string[] }> = [
  { label: "All", value: null },
  { label: "Pool", value: ["pool", "cli:pool"] },
  { label: "Image", value: ["cli:image", "image:build"] },
  { label: "SSH", value: ["ssh"] },
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
