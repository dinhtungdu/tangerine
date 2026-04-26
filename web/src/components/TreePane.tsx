import { memo, useState, useCallback, useRef, useEffect, useMemo } from "react"
import type { TaskTreeNode, Checkpoint } from "@tangerine/shared"
import { getStatusConfig } from "../lib/status"
import { useProjectNav } from "../hooks/useProjectNav"
import { formatTimestamp } from "../lib/format"

interface TreePaneProps {
  taskId: string
  tree: TaskTreeNode | null
  loading: boolean
  checkpoints?: Checkpoint[]
  onBranch?: (checkpoint: Checkpoint) => void
}

// ---------------------------------------------------------------------------
// Flat node model — drives keyboard navigation
// ---------------------------------------------------------------------------

type FlatNode =
  | { kind: "task"; id: string; taskId: string; depth: number; node: TaskTreeNode }
  | { kind: "turn"; id: string; taskId: string; turnIndex: number; checkpointId: string; depth: number }

function flattenTree(
  node: TaskTreeNode,
  collapsed: Set<string>,
  depth: number,
  out: FlatNode[],
): void {
  out.push({ kind: "task", id: `task:${node.taskId}`, taskId: node.taskId, depth, node })
  if (collapsed.has(node.taskId)) return
  for (const turn of node.turns) {
    out.push({
      kind: "turn",
      id: `turn:${node.taskId}:${turn.turnIndex}`,
      taskId: node.taskId,
      turnIndex: turn.turnIndex,
      checkpointId: turn.checkpointId,
      depth: depth + 1,
    })
    for (const branch of turn.branches) {
      flattenTree(branch, collapsed, depth + 2, out)
    }
  }
}

function buildFlatList(tree: TaskTreeNode, collapsed: Set<string>): FlatNode[] {
  const out: FlatNode[] = []
  flattenTree(tree, collapsed, 0, out)
  return out
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: string }) {
  const { color } = getStatusConfig(status as Parameters<typeof getStatusConfig>[0])
  const isRunning = status === "running"
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${isRunning ? "animate-pulse" : ""}`}
      style={{ backgroundColor: color }}
    />
  )
}

interface TreeNodeProps {
  node: TaskTreeNode
  currentTaskId: string
  depth: number
  collapsed: Set<string>
  focusedId: string | null
  onToggle: (taskId: string) => void
  onFocus: (id: string) => void
  nodeRefs: React.MutableRefObject<Map<string, HTMLElement>>
  tree: TaskTreeNode
  search: string
  checkpoints?: Checkpoint[]
  onBranch?: (checkpoint: Checkpoint) => void
  continuingDepths?: boolean[]
  isLast?: boolean
}

// Timeline gutter: circle on main line, dashed connectors for nested items
const TIMELINE_WIDTH = 28 // width of main timeline column
const INDENT_WIDTH = 16 // additional indent per depth level

function TreeGutter({ depth, continuingDepths: _continuingDepths, isLast: _isLast }: { depth: number; continuingDepths: boolean[]; isLast: boolean }) {
  // Depth 0 & 1: circle on main timeline
  if (depth <= 1) {
    return (
      <div className="relative flex shrink-0 items-center justify-center" style={{ width: TIMELINE_WIDTH }} aria-hidden>
        {/* Circle node on top of the vertical line */}
        <div className="z-10 h-2 w-2 rounded-full border-[1.5px] border-muted-foreground/60 bg-background" />
      </div>
    )
  }

  // Depth 2+: timeline column + dashed connector
  const extraIndent = (depth - 1) * INDENT_WIDTH

  return (
    <div className="flex shrink-0 self-stretch" style={{ width: TIMELINE_WIDTH + extraIndent }} aria-hidden>
      {/* Timeline column - just empty space over the background line */}
      <div style={{ width: TIMELINE_WIDTH }} />
      {/* Dashed connector area */}
      <div className="relative flex-1 flex items-center">
        {/* Horizontal dashed line */}
        <div className="h-px w-full border-t border-dashed border-muted-foreground/40" />
        {/* Small dot at end */}
        <div className="absolute right-0 h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
      </div>
    </div>
  )
}

const TreeNode = memo(function TreeNode({
  node,
  currentTaskId,
  depth,
  collapsed,
  focusedId,
  onToggle,
  onFocus,
  nodeRefs,
  tree,
  search,
  checkpoints,
  onBranch,
  continuingDepths = [],
  isLast = true,
}: TreeNodeProps) {
  const { link, navigate } = useProjectNav()
  const isCurrent = node.taskId === currentTaskId
  const checkpointMap = useMemo(
    () => new Map(checkpoints?.map((cp) => [cp.id, cp]) ?? []),
    [checkpoints],
  )
  const hasBranches = node.turns.some((t) => t.branches.length > 0)
  const isRunning = node.status === "running"
  const isCollapsed = collapsed.has(node.taskId)
  const taskNodeId = `task:${node.taskId}`
  const isFocused = focusedId === taskNodeId

  const setRef = useCallback(
    (el: HTMLElement | null) => {
      if (el) nodeRefs.current.set(taskNodeId, el)
      else nodeRefs.current.delete(taskNodeId)
    },
    [nodeRefs, taskNodeId],
  )

  const handleNodeClick = useCallback(() => {
    navigate(`/tasks/${node.taskId}`)
  }, [navigate, node.taskId])

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onToggle(node.taskId)
    },
    [onToggle, node.taskId],
  )

  // Filter: hide task node only if search active AND neither the task nor any
  // of its visible turns match (always show task headers so tree structure is clear)
  const taskVisible = !search || node.title.toLowerCase().includes(search.toLowerCase())

  return (
    <div className="flex flex-col">
      {/* Task header row */}
      <div
        ref={setRef}
        className={`group flex items-center gap-1 rounded px-2 py-1.5 text-xs transition-colors ${isCurrent ? "cursor-default bg-muted font-medium text-foreground" : "cursor-pointer touch-manipulation hover:bg-muted active:bg-muted text-muted-foreground"} ${isFocused ? "ring-1 ring-ring" : ""} ${!taskVisible ? "opacity-40" : ""}`}
        onClick={isCurrent ? undefined : handleNodeClick}
        onFocus={(e) => { if (e.target === e.currentTarget) onFocus(taskNodeId) }}
        role="treeitem"
        aria-expanded={hasBranches ? !isCollapsed : undefined}
        tabIndex={isFocused ? 0 : -1}
        title={node.title}
      >
        <TreeGutter depth={depth} continuingDepths={continuingDepths} isLast={isLast} />
        {hasBranches && (
          <button
            onClick={handleToggle}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={isCollapsed ? "Expand" : "Collapse"}
            tabIndex={-1}
          >
            <svg
              className={`h-3 w-3 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m9 18 6-6-6-6" />
            </svg>
          </button>
        )}
        {!hasBranches && <span className="w-3 shrink-0" />}
        <StatusDot status={node.status} />
        <span className="min-w-0 flex-1 truncate">{node.title}</span>
        {isRunning && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-2xs text-amber-500">running</span>
        )}
      </div>

      {/* Turns + branches */}
      {!isCollapsed && node.turns.map((turn, turnIdx) => {
        const turnNodeId = `turn:${node.taskId}:${turn.turnIndex}`
        const isTurnFocused = focusedId === turnNodeId
        const turnVisible = !search || (turn.lastMessage ?? "").toLowerCase().includes(search.toLowerCase())
        const isLastTurn = turnIdx === node.turns.length - 1

        const setTurnRef = (el: HTMLElement | null) => {
          if (el) nodeRefs.current.set(turnNodeId, el)
          else nodeRefs.current.delete(turnNodeId)
        }

        // Turns under the current task navigate to the same URL — no-op.
        // Render as a non-interactive div; only turns under other tasks are links.
        const TurnEl = isCurrent ? "div" : "a"
        const turnLinkProps = isCurrent
          ? {}
          : {
              href: link(`/tasks/${node.taskId}`),
              onClick: (e: React.MouseEvent) => { e.preventDefault(); navigate(`/tasks/${node.taskId}`) },
            }

        // Find checkpoint for this turn to enable branching (O(1) via Map)
        const checkpoint = isCurrent && onBranch
          ? checkpointMap.get(turn.checkpointId)
          : undefined

        // Continuing depths for turn row: parent continues if not last, plus task depth continues if more turns
        const turnContinuing = [...continuingDepths, !isLast, !isLastTurn]

        return (
          <div key={turn.checkpointId}>
            {/* Turn row */}
            <TurnEl
              ref={setTurnRef as React.RefCallback<HTMLElement>}
              {...turnLinkProps}
              onFocus={(e) => { if (e.target === e.currentTarget) onFocus(turnNodeId) }}
              className={`group/turn flex items-center gap-1 rounded px-2 py-1 text-2xs transition-colors ${isCurrent ? "text-foreground/70 hover:bg-muted/40" : "cursor-pointer touch-manipulation hover:bg-muted/60 active:bg-muted/60 text-muted-foreground/60"} ${isTurnFocused ? "ring-1 ring-ring" : ""} ${!turnVisible ? "opacity-30" : ""}`}
              tabIndex={isTurnFocused ? 0 : -1}
              role="treeitem"
              title={turn.lastMessage || `Turn ${turn.turnIndex + 1}`}
            >
              <TreeGutter depth={depth + 1} continuingDepths={turnContinuing} isLast={isLastTurn && turn.branches.length === 0} />
              <svg className="h-2.5 w-2.5 shrink-0 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span className="min-w-0 flex-1 truncate">
                {turn.lastMessage
                  ? turn.lastMessage.slice(0, 60) + (turn.lastMessage.length > 60 ? "…" : "")
                  : `Turn ${turn.turnIndex + 1}`}
              </span>
              {checkpoint && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onBranch!(checkpoint) }}
                  className="shrink-0 rounded px-1.5 py-0.5 text-2xs text-muted-foreground md:opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 focus-visible:ring-1 focus-visible:ring-ring md:group-hover/turn:opacity-100"
                  title="Branch from this turn"
                  aria-label="Branch from this turn"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                  </svg>
                </button>
              )}
              <span className={`shrink-0 text-muted-foreground/40 ${checkpoint ? "hidden md:inline md:group-hover/turn:hidden" : ""}`}>{formatTimestamp(turn.createdAt)}</span>
            </TurnEl>

            {/* Branches off this turn */}
            {turn.branches.length > 0 && (
              <div className="flex flex-col">
                {turn.branches.map((branch, branchIdx) => (
                  <TreeNode
                    key={branch.taskId}
                    node={branch}
                    currentTaskId={currentTaskId}
                    depth={depth + 2}
                    collapsed={collapsed}
                    focusedId={focusedId}
                    onToggle={onToggle}
                    onFocus={onFocus}
                    nodeRefs={nodeRefs}
                    tree={tree}
                    search={search}
                    checkpoints={checkpoints}
                    onBranch={onBranch}
                    continuingDepths={[...turnContinuing, branchIdx < turn.branches.length - 1]}
                    isLast={branchIdx === turn.branches.length - 1 && isLastTurn}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Main pane
// ---------------------------------------------------------------------------

export function TreePane({ taskId, tree, loading, checkpoints, onBranch }: TreePaneProps) {
  const { navigate } = useProjectNav()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const handleToggle = useCallback((nodeTaskId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(nodeTaskId)) next.delete(nodeTaskId)
      else next.add(nodeTaskId)
      return next
    })
  }, [])

  const flatNodes = useMemo(
    () => (tree ? buildFlatList(tree, collapsed) : []),
    [tree, collapsed],
  )

  // Focus the DOM element for the focused node
  useEffect(() => {
    if (focusedId) {
      nodeRefs.current.get(focusedId)?.focus({ preventScroll: false })
    }
  }, [focusedId])

  // Auto-focus the current task's node on mount
  useEffect(() => {
    if (!tree) return
    const currentNodeId = `task:${taskId}`
    setFocusedId(currentNodeId)
  }, [tree, taskId])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Let search input handle its own keys
      if (document.activeElement === searchRef.current) {
        if (e.key === "Escape") {
          setSearch("")
          searchRef.current?.blur()
        }
        return
      }

      const currentIndex = flatNodes.findIndex((n) => n.id === focusedId)

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault()
          const next = flatNodes[currentIndex + 1]
          if (next) setFocusedId(next.id)
          break
        }
        case "ArrowUp": {
          e.preventDefault()
          if (currentIndex <= 0) {
            // Jump to search
            searchRef.current?.focus()
          } else {
            const prev = flatNodes[currentIndex - 1]
            if (prev) setFocusedId(prev.id)
          }
          break
        }
        case "ArrowRight": {
          e.preventDefault()
          const cur = flatNodes[currentIndex]
          if (cur?.kind === "task" && collapsed.has(cur.taskId)) {
            setCollapsed((prev) => {
              const next = new Set(prev)
              next.delete(cur.taskId)
              return next
            })
          }
          break
        }
        case "ArrowLeft": {
          e.preventDefault()
          const cur = flatNodes[currentIndex]
          if (cur?.kind === "task") {
            const hasBranches = cur.node.turns.some((t) => t.branches.length > 0)
            if (hasBranches && !collapsed.has(cur.taskId)) {
              // Collapse current task
              setCollapsed((prev) => new Set([...prev, cur.taskId]))
            } else {
              // Move to parent task node if any
              const parentIdx = flatNodes.slice(0, currentIndex).findLastIndex(
                (n) => n.kind === "task" && n.depth < cur.depth
              )
              if (parentIdx >= 0) setFocusedId(flatNodes[parentIdx]!.id)
            }
          } else if (cur?.kind === "turn") {
            // Move to the owning task node
            const parentIdx = flatNodes.slice(0, currentIndex).findLastIndex(
              (n) => n.kind === "task" && n.taskId === cur.taskId
            )
            if (parentIdx >= 0) setFocusedId(flatNodes[parentIdx]!.id)
          }
          break
        }
        case "Enter": {
          e.preventDefault()
          const cur = flatNodes[currentIndex]
          if (cur && cur.taskId !== taskId) navigate(`/tasks/${cur.taskId}`)
          break
        }
        case "/": {
          e.preventDefault()
          searchRef.current?.focus()
          break
        }
      }
    },
    [flatNodes, focusedId, collapsed, navigate, taskId],
  )

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

  return (
    <div
      ref={containerRef}
      className="flex h-full flex-col overflow-hidden"
      onKeyDown={handleKeyDown}
      role="tree"
      aria-label="Conversation tree"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <svg className="h-3.5 w-3.5 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
        </svg>
        <span className="text-xs font-medium">Conversation tree</span>
      </div>

      {/* Search */}
      <div className="border-b border-border px-2 py-1.5">
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setSearch(""); e.currentTarget.blur() }
            if (e.key === "ArrowDown") {
              e.preventDefault()
              const first = flatNodes[0]
              if (first) { setFocusedId(first.id); e.currentTarget.blur() }
            }
          }}
          placeholder="Filter… (/)"
          className="w-full rounded border border-border bg-background px-2 py-1 text-2xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
          aria-label="Filter tree nodes"
        />
      </div>

      {/* Tree */}
      <div className="relative flex-1 touch-pan-y overflow-y-auto py-1">
        {/* Main vertical timeline line */}
        <div
          className="pointer-events-none absolute left-[18px] top-0 bottom-0 w-0.5 bg-border"
          aria-hidden
        />
        <TreeNode
          node={tree}
          currentTaskId={taskId}
          depth={0}
          collapsed={collapsed}
          focusedId={focusedId}
          onToggle={handleToggle}
          onFocus={setFocusedId}
          nodeRefs={nodeRefs}
          tree={tree}
          search={search}
          checkpoints={checkpoints}
          onBranch={onBranch}
        />
      </div>

      {/* Keyboard hint */}
      <div className="border-t border-border px-3 py-1.5 text-2xs text-muted-foreground/40">
        ↑↓ navigate · ←→ expand/collapse · Enter select · / search
      </div>
    </div>
  )
}
