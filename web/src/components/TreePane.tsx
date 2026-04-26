import { memo, useState, useCallback, useRef, useEffect, useMemo } from "react"
import type { TaskTreeNode, Checkpoint } from "@tangerine/shared"
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

// Mark IDs on the chain from root → current task. Includes ancestor task IDs, turns up to
// and including the turn that branches toward current, and all turns of the current task.
function computeActivePath(node: TaskTreeNode, currentTaskId: string): Set<string> {
  const path = new Set<string>()
  function walk(n: TaskTreeNode): boolean {
    path.add(`task:${n.taskId}`)
    if (n.taskId === currentTaskId) {
      for (const t of n.turns) path.add(`turn:${n.taskId}:${t.turnIndex}`)
      return true
    }
    const addedTurns: string[] = []
    for (const turn of n.turns) {
      const turnId = `turn:${n.taskId}:${turn.turnIndex}`
      for (const branch of turn.branches) {
        if (walk(branch)) {
          path.add(turnId)
          return true
        }
      }
      path.add(turnId)
      addedTurns.push(turnId)
    }
    path.delete(`task:${n.taskId}`)
    for (const id of addedTurns) path.delete(id)
    return false
  }
  walk(node)
  return path
}

// ---------------------------------------------------------------------------
// Rail / marker primitives
// ---------------------------------------------------------------------------

const RAIL_INDENT = 16 // px per depth level
const RAIL_OFFSET = 14 // x-position of rail center within depth column

function railLeft(depth: number): number {
  return depth * RAIL_INDENT + RAIL_OFFSET
}

interface RailDescriptor {
  depth: number
  onPath: boolean
}

function railColor(onPath: boolean) {
  return onPath ? "var(--color-status-info)" : "var(--border)"
}

function railOpacity(onPath: boolean) {
  return onPath ? 0.55 : 0.55
}

function Rails({ rails }: { rails: RailDescriptor[] }) {
  return (
    <>
      {rails.map((r) => (
        <span
          key={r.depth}
          aria-hidden
          className="pointer-events-none absolute top-0 bottom-0 w-px"
          style={{
            left: `${railLeft(r.depth) + 3}px`,
            backgroundColor: railColor(r.onPath),
            opacity: railOpacity(r.onPath),
          }}
        />
      ))}
    </>
  )
}

function NodeMarker({ onPath, isCurrent }: { onPath: boolean; isCurrent: boolean }) {
  if (onPath) {
    return (
      <span
        className="block h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: "var(--color-status-info)" }}
        aria-hidden
      />
    )
  }
  return (
    <span
      className={`block h-2.5 w-2.5 shrink-0 rounded-full border bg-background ${isCurrent ? "border-foreground" : "border-muted-foreground/50"}`}
      aria-hidden
    />
  )
}

// Curved L-connector from a parent rail to a branch dot. Rendered as a div with
// border-left + border-bottom and a border-bottom-left-radius for the curve.
function LConnector({ parentDepth, depth, onPath }: { parentDepth: number; depth: number; onPath: boolean }) {
  const parentX = railLeft(parentDepth) + 3
  const dotX = railLeft(depth) + 3
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        left: `${parentX}px`,
        top: 0,
        width: `${dotX - parentX}px`,
        height: "50%",
        borderLeft: `1px solid ${railColor(onPath)}`,
        borderBottom: `1px solid ${railColor(onPath)}`,
        borderBottomLeftRadius: "10px",
        opacity: railOpacity(onPath),
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface TreeNodeProps {
  node: TaskTreeNode
  currentTaskId: string
  depth: number
  // Rails inherited from ancestors that pass continuously through every row
  ancestorRails: RailDescriptor[]
  // L-connector: if this task is a branch off a parent turn, parentDepth = turn depth
  parentTurnDepth: number | null
  collapsed: Set<string>
  focusedId: string | null
  activePath: Set<string>
  onToggle: (taskId: string) => void
  onFocus: (id: string) => void
  nodeRefs: React.MutableRefObject<Map<string, HTMLElement>>
  tree: TaskTreeNode
  search: string
  checkpoints?: Checkpoint[]
  onBranch?: (checkpoint: Checkpoint) => void
}

const TreeNode = memo(function TreeNode({
  node,
  currentTaskId,
  depth,
  ancestorRails,
  parentTurnDepth,
  collapsed,
  focusedId,
  activePath,
  onToggle,
  onFocus,
  nodeRefs,
  tree,
  search,
  checkpoints,
  onBranch,
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
  const onPath = activePath.has(taskNodeId)

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

  const taskVisible = !search || node.title.toLowerCase().includes(search.toLowerCase())
  const dotX = railLeft(depth)

  // Rails passed to descendants: ancestors + own task rail
  const childAncestorRails: RailDescriptor[] = [...ancestorRails, { depth, onPath }]

  return (
    <div className="flex flex-col">
      {/* Task header row */}
      <div
        ref={setRef}
        className={`group relative flex min-h-[34px] items-center gap-2 py-1 pr-2 text-xs transition-colors ${
          isFocused
            ? "rounded-lg bg-[color:var(--color-status-info-bg)]/40 ring-2 ring-[color:var(--color-status-info)]"
            : isCurrent
              ? "cursor-default font-medium text-foreground"
              : "cursor-pointer touch-manipulation hover:bg-muted active:bg-muted text-foreground/80"
        } ${!taskVisible ? "opacity-40" : ""}`}
        style={{ paddingLeft: `${dotX + 14}px` }}
        onClick={isCurrent ? undefined : handleNodeClick}
        onFocus={(e) => { if (e.target === e.currentTarget) onFocus(taskNodeId) }}
        role="treeitem"
        aria-expanded={hasBranches ? !isCollapsed : undefined}
        tabIndex={isFocused ? 0 : -1}
        title={node.title}
      >
        {/* Continuous ancestor rails */}
        <Rails rails={ancestorRails} />
        {/* Own rail through this row at own depth (only if there are turns/children below) */}
        {!isCollapsed && node.turns.length > 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute w-px"
            style={{
              left: `${dotX + 3}px`,
              top: "50%",
              bottom: 0,
              backgroundColor: railColor(onPath),
              opacity: railOpacity(onPath),
            }}
          />
        )}
        {/* Branch L-connector from parent turn rail */}
        {parentTurnDepth !== null && (
          <LConnector parentDepth={parentTurnDepth} depth={depth} onPath={onPath} />
        )}
        {/* Node marker centered on rail */}
        <span className="absolute" style={{ left: `${dotX - 2}px`, top: "50%", transform: "translateY(-50%)" }}>
          <NodeMarker onPath={onPath} isCurrent={isCurrent} />
        </span>
        <span className="min-w-0 flex-1 truncate">{node.title}</span>
        {isRunning && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-2xs font-medium text-amber-600 dark:text-amber-400">running</span>
        )}
        {hasBranches ? (
          <button
            onClick={handleToggle}
            className="shrink-0 text-muted-foreground/60 hover:text-foreground"
            aria-label={isCollapsed ? "Expand" : "Collapse"}
            tabIndex={-1}
          >
            <svg
              className={`h-3.5 w-3.5 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m9 18 6-6-6-6" />
            </svg>
          </button>
        ) : (
          <svg className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
          </svg>
        )}
      </div>

      {/* Turns + branches */}
      {!isCollapsed && node.turns.map((turn) => {
        const turnNodeId = `turn:${node.taskId}:${turn.turnIndex}`
        const isTurnFocused = focusedId === turnNodeId
        const turnOnPath = activePath.has(turnNodeId)
        const turnVisible = !search || (turn.lastMessage ?? "").toLowerCase().includes(search.toLowerCase())
        const turnDepth = depth + 1
        const turnDotX = railLeft(turnDepth)
        const setTurnRef = (el: HTMLElement | null) => {
          if (el) nodeRefs.current.set(turnNodeId, el)
          else nodeRefs.current.delete(turnNodeId)
        }

        const TurnEl = isCurrent ? "div" : "a"
        const turnLinkProps = isCurrent
          ? {}
          : {
              href: link(`/tasks/${node.taskId}`),
              onClick: (e: React.MouseEvent) => { e.preventDefault(); navigate(`/tasks/${node.taskId}`) },
            }

        const checkpoint = isCurrent && onBranch
          ? checkpointMap.get(turn.checkpointId)
          : undefined

        return (
          <div key={turn.checkpointId}>
            {/* Turn row */}
            <TurnEl
              ref={setTurnRef as React.RefCallback<HTMLElement>}
              {...turnLinkProps}
              onFocus={(e) => { if (e.target === e.currentTarget) onFocus(turnNodeId) }}
              className={`group/turn relative flex min-h-[28px] items-center gap-2 py-0.5 pr-2 text-2xs transition-colors ${
                isTurnFocused
                  ? "rounded-lg bg-[color:var(--color-status-info-bg)]/40 ring-2 ring-[color:var(--color-status-info)]"
                  : isCurrent
                    ? "text-foreground/80 hover:bg-muted/40"
                    : "cursor-pointer touch-manipulation hover:bg-muted/60 active:bg-muted/60 text-muted-foreground"
              } ${!turnVisible ? "opacity-30" : ""}`}
              style={{ paddingLeft: `${turnDotX + 14}px` }}
              tabIndex={isTurnFocused ? 0 : -1}
              role="treeitem"
              title={turn.lastMessage || `Turn ${turn.turnIndex + 1}`}
            >
              {/* Continuous ancestor rails */}
              <Rails rails={ancestorRails} />
              {/* Parent task rail through this row */}
              <span
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 w-px"
                style={{
                  left: `${dotX + 3}px`,
                  backgroundColor: railColor(onPath),
                  opacity: railOpacity(onPath),
                }}
              />
              {/* Horizontal connector from parent task rail to turn dot */}
              <span
                aria-hidden
                className="pointer-events-none absolute h-px"
                style={{
                  left: `${dotX + 3}px`,
                  top: "50%",
                  width: `${turnDotX - dotX}px`,
                  backgroundColor: railColor(turnOnPath),
                  opacity: railOpacity(turnOnPath),
                }}
              />
              {/* Own turn rail (extends down if branches follow) */}
              {turn.branches.length > 0 && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute w-px"
                  style={{
                    left: `${turnDotX + 3}px`,
                    top: "50%",
                    bottom: 0,
                    backgroundColor: railColor(turnOnPath),
                    opacity: railOpacity(turnOnPath),
                  }}
                />
              )}
              {/* Node marker */}
              <span className="absolute" style={{ left: `${turnDotX - 2}px`, top: "50%", transform: "translateY(-50%)" }}>
                <NodeMarker onPath={turnOnPath} isCurrent={false} />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {turn.lastMessage
                  ? turn.lastMessage.slice(0, 80) + (turn.lastMessage.length > 80 ? "…" : "")
                  : `Turn ${turn.turnIndex + 1}`}
              </span>
              {checkpoint ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onBranch!(checkpoint) }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                  title="Branch from this turn"
                  aria-label="Branch from this turn"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                  </svg>
                </button>
              ) : (
                <>
                  <span className="hidden shrink-0 text-muted-foreground/50 md:inline">{formatTimestamp(turn.createdAt)}</span>
                  <svg className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                  </svg>
                </>
              )}
            </TurnEl>

            {/* Branches off this turn */}
            {turn.branches.length > 0 && (
              <div className="flex flex-col">
                {turn.branches.map((branch, branchIdx) => {
                  const isLastBranch = branchIdx === turn.branches.length - 1
                  // Turn rail continues through branch rows only if more branches follow
                  // OR if more turns follow (parent task rail handles ancestor rails for siblings).
                  const turnRailContinues = !isLastBranch
                  const branchAncestorRails: RailDescriptor[] = turnRailContinues
                    ? [...childAncestorRails, { depth: turnDepth, onPath: turnOnPath }]
                    : childAncestorRails
                  return (
                    <TreeNode
                      key={branch.taskId}
                      node={branch}
                      currentTaskId={currentTaskId}
                      depth={depth + 2}
                      ancestorRails={branchAncestorRails}
                      parentTurnDepth={turnDepth}
                      collapsed={collapsed}
                      focusedId={focusedId}
                      activePath={activePath}
                      onToggle={onToggle}
                      onFocus={onFocus}
                      nodeRefs={nodeRefs}
                      tree={tree}
                      search={search}
                      checkpoints={checkpoints}
                      onBranch={onBranch}
                    />
                  )
                })}
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

  const activePath = useMemo(
    () => (tree ? computeActivePath(tree, taskId) : new Set<string>()),
    [tree, taskId],
  )

  useEffect(() => {
    if (focusedId) {
      nodeRefs.current.get(focusedId)?.focus({ preventScroll: false })
    }
  }, [focusedId])

  useEffect(() => {
    if (!tree) return
    const currentNodeId = `task:${taskId}`
    setFocusedId(currentNodeId)
  }, [tree, taskId])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
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
              setCollapsed((prev) => new Set([...prev, cur.taskId]))
            } else {
              const parentIdx = flatNodes.slice(0, currentIndex).findLastIndex(
                (n) => n.kind === "task" && n.depth < cur.depth
              )
              if (parentIdx >= 0) setFocusedId(flatNodes[parentIdx]!.id)
            }
          } else if (cur?.kind === "turn") {
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
      <div className="flex-1 touch-pan-y overflow-y-auto py-1">
        <TreeNode
          node={tree}
          currentTaskId={taskId}
          depth={0}
          ancestorRails={[]}
          parentTurnDepth={null}
          collapsed={collapsed}
          focusedId={focusedId}
          activePath={activePath}
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
