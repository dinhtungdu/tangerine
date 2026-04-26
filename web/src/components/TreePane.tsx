import { memo, useState, useMemo, useCallback } from "react"
import type { TaskTreeNode, Checkpoint } from "@tangerine/shared"
import { useProjectNav } from "../hooks/useProjectNav"
import { formatRelativeTime } from "../lib/format"

interface TreePaneProps {
  taskId: string
  tree: TaskTreeNode | null
  loading: boolean
  checkpoints?: Checkpoint[]
  onBranch?: (checkpoint: Checkpoint) => void
}

interface FlatBranch {
  node: TaskTreeNode
  depth: number
  /** Branched off a turn in the parent (true = render as indented sub-branch with corner connector) */
  isBranchedChild: boolean
  /** Visual abandoned state (e.g. cancelled tasks) */
  abandoned: boolean
}

function flatten(node: TaskTreeNode, depth: number, isBranchedChild: boolean, out: FlatBranch[]): void {
  const abandoned = node.status === "cancelled" || node.status === "failed"
  out.push({ node, depth, isBranchedChild, abandoned })
  for (const turn of node.turns) {
    for (const branch of turn.branches) {
      flatten(branch, depth + 1, true, out)
    }
  }
}

function getDescription(node: TaskTreeNode): string {
  if (node.turns.length === 0) return ""
  const last = node.turns[node.turns.length - 1]!
  return last.lastMessage ?? ""
}

function getUpdatedAt(node: TaskTreeNode): string | null {
  if (node.turns.length === 0) return null
  return node.turns[node.turns.length - 1]!.createdAt
}

type BadgeKind = "active" | "completed" | "in-progress" | "abandoned" | "queued"

function getBadge(node: TaskTreeNode, isCurrent: boolean): { kind: BadgeKind; label: string } {
  if (isCurrent) return { kind: "active", label: "Active" }
  switch (node.status) {
    case "running":      return { kind: "in-progress", label: "In progress" }
    case "done":         return { kind: "completed",   label: "Completed" }
    case "cancelled":    return { kind: "abandoned",   label: "Abandoned" }
    case "failed":       return { kind: "abandoned",   label: "Failed" }
    case "created":
    case "provisioning": return { kind: "queued",      label: "Queued" }
    default:             return { kind: "abandoned",   label: node.status }
  }
}

const ICON_BG: Record<BadgeKind, string> = {
  "active":      "bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300",
  "completed":   "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300",
  "in-progress": "bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300",
  "abandoned":   "bg-muted text-muted-foreground",
  "queued":      "bg-sky-100 text-sky-600 dark:bg-sky-500/20 dark:text-sky-300",
}

function BadgePill({ kind, label }: { kind: BadgeKind; label: string }) {
  if (kind === "active") {
    return (
      <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-2xs font-medium text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">
        {label}
      </span>
    )
  }
  const dot: Record<BadgeKind, string> = {
    "active":      "bg-violet-500",
    "completed":   "bg-emerald-500",
    "in-progress": "bg-amber-500",
    "abandoned":   "bg-muted-foreground/50",
    "queued":      "bg-sky-500",
  }
  const text: Record<BadgeKind, string> = {
    "active":      "text-violet-600",
    "completed":   "text-emerald-600 dark:text-emerald-400",
    "in-progress": "text-amber-600 dark:text-amber-400",
    "abandoned":   "text-muted-foreground",
    "queued":      "text-sky-600 dark:text-sky-400",
  }
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-2xs font-medium ${text[kind]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${kind === "in-progress" ? "animate-pulse " : ""}${dot[kind]}`} />
      {label}
    </span>
  )
}

function BranchIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
    </svg>
  )
}

interface BranchCardProps {
  flat: FlatBranch
  isCurrent: boolean
  onSelect: (taskId: string) => void
}

const BranchCard = memo(function BranchCard({ flat, isCurrent, onSelect }: BranchCardProps) {
  const { node, depth, isBranchedChild, abandoned } = flat
  const badge = getBadge(node, isCurrent)
  const description = getDescription(node)
  const updatedAt = getUpdatedAt(node)
  const turnCount = node.turns.length

  const handleClick = useCallback(() => {
    if (!isCurrent) onSelect(node.taskId)
  }, [isCurrent, onSelect, node.taskId])

  const indent = depth * 24

  return (
    <div className="relative flex items-stretch" style={{ paddingLeft: indent }}>
      {/* Timeline gutter (circle + connector lines) */}
      <div className="relative flex w-6 shrink-0 items-start justify-center">
        {/* vertical line through gutter */}
        <span
          aria-hidden
          className={`absolute left-1/2 top-0 -translate-x-1/2 h-full w-px ${abandoned ? "border-l border-dashed border-border" : "bg-border"}`}
        />
        {/* L-connector for branched children */}
        {isBranchedChild && (
          <span
            aria-hidden
            className={`absolute right-full top-5 h-px w-6 ${abandoned ? "border-t border-dashed border-border" : "bg-border"}`}
          />
        )}
        {/* circle */}
        <span
          aria-hidden
          className={`relative z-10 mt-4 inline-block h-2.5 w-2.5 rounded-full border-2 ${isCurrent ? "border-violet-500 bg-background" : "border-border bg-background"}`}
        />
      </div>

      {/* Card */}
      <button
        type="button"
        onClick={handleClick}
        disabled={isCurrent}
        className={[
          "group ml-2 mb-2 flex flex-1 items-start gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors",
          isCurrent
            ? "border-violet-500 bg-violet-50 dark:bg-violet-500/10"
            : "border-border bg-card hover:border-foreground/20 hover:bg-muted/40",
          abandoned ? "opacity-70" : "",
        ].join(" ")}
        aria-current={isCurrent ? "true" : undefined}
      >
        {/* Icon circle */}
        <span className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${ICON_BG[badge.kind]}`}>
          <BranchIcon />
        </span>

        {/* Body */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{node.title}</span>
            <BadgePill kind={badge.kind} label={badge.label} />
          </div>
          {description && (
            <p className="mt-1 line-clamp-1 text-2xs text-muted-foreground">{description}</p>
          )}
          <div className="mt-1.5 flex items-center gap-2 text-2xs text-muted-foreground/70">
            <span className="inline-flex items-center gap-1">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
              {turnCount}
            </span>
            <span aria-hidden>·</span>
            <span>{updatedAt ? `Updated ${formatRelativeTime(updatedAt)}` : "No updates"}</span>
          </div>
        </div>

        {/* Selection circle + chevron */}
        <div className="flex shrink-0 items-center gap-1.5 self-center">
          {isCurrent ? (
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-violet-600 text-white">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </span>
          ) : (
            <span className="inline-block h-5 w-5 rounded-full border border-border" />
          )}
          <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m9 18 6-6-6-6" />
          </svg>
        </div>
      </button>
    </div>
  )
})

// ---------------------------------------------------------------------------

export function TreePane({ taskId, tree, loading, checkpoints, onBranch }: TreePaneProps) {
  const { navigate } = useProjectNav()
  const [search, setSearch] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)

  const flat = useMemo<FlatBranch[]>(() => {
    if (!tree) return []
    const out: FlatBranch[] = []
    flatten(tree, 0, false, out)
    return out
  }, [tree])

  const filtered = useMemo(() => {
    if (!search) return flat
    const q = search.toLowerCase()
    return flat.filter((f) =>
      f.node.title.toLowerCase().includes(q) ||
      getDescription(f.node).toLowerCase().includes(q),
    )
  }, [flat, search])

  const totalCount = flat.length
  const activeCount = useMemo(
    () => flat.filter((f) => f.node.status === "running").length,
    [flat],
  )

  const handleSelect = useCallback((id: string) => {
    navigate(`/tasks/${id}`)
  }, [navigate])

  const latestCheckpoint = checkpoints && checkpoints.length > 0
    ? checkpoints[checkpoints.length - 1]!
    : null

  const handleNewBranch = useCallback(() => {
    if (latestCheckpoint && onBranch) onBranch(latestCheckpoint)
  }, [latestCheckpoint, onBranch])

  const handleSwitchToMain = useCallback(() => {
    if (tree && tree.taskId !== taskId) navigate(`/tasks/${tree.taskId}`)
  }, [tree, taskId, navigate])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading tree…
      </div>
    )
  }

  if (!tree) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No tree data
      </div>
    )
  }

  const isOnRoot = tree.taskId === taskId
  const canBranch = !!latestCheckpoint && !!onBranch

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Branch explorer</h2>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {totalCount} {totalCount === 1 ? "branch" : "branches"}
            {activeCount > 0 && <> · {activeCount} active</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted ${searchOpen ? "bg-muted text-foreground" : ""}`}
            aria-label="Search branches"
            aria-pressed={searchOpen}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" />
            </svg>
          </button>
          <button
            type="button"
            disabled
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground/50"
            aria-label="Filter (coming soon)"
            title="Filters coming soon"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h12M9 12h6M11 18h2" />
            </svg>
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="border-b border-border px-4 py-2">
          <input
            autoFocus
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter branches…"
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label="Filter branches"
          />
        </div>
      )}

      {/* List */}
      <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto px-3 py-3">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No branches match
          </div>
        ) : (
          filtered.map((f) => (
            <BranchCard
              key={f.node.taskId}
              flat={f}
              isCurrent={f.node.taskId === taskId}
              onSelect={handleSelect}
            />
          ))
        )}
      </div>

      {/* Bottom action bar */}
      <div className="grid grid-cols-3 gap-2 border-t border-border bg-background px-3 py-2">
        <button
          type="button"
          onClick={handleNewBranch}
          disabled={!canBranch}
          className="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium text-violet-600 hover:bg-violet-50 disabled:opacity-40 disabled:hover:bg-transparent dark:text-violet-300 dark:hover:bg-violet-500/10"
          title={canBranch ? "Branch from latest checkpoint" : "No checkpoints yet"}
        >
          <BranchIcon />
          New branch
        </button>
        <button
          type="button"
          disabled
          className="inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium text-muted-foreground opacity-50"
          title="Compare coming soon"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h13l-3-3m3 3-3 3M21 18H8l3 3m-3-3 3-3" />
          </svg>
          Compare
        </button>
        <button
          type="button"
          onClick={handleSwitchToMain}
          disabled={isOnRoot}
          className="inline-flex items-center justify-center rounded-md bg-violet-600 px-3 py-2 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-40 disabled:hover:bg-violet-600"
        >
          {isOnRoot ? "On main" : "Switch to main"}
        </button>
      </div>
    </div>
  )
}
