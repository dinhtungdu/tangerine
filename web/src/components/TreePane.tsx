import { memo, useState, useCallback } from "react"
import type { TaskTreeNode } from "@tangerine/shared"
import { getStatusConfig } from "../lib/status"
import { useProjectNav } from "../hooks/useProjectNav"
import { formatTimestamp } from "../lib/format"

interface TreePaneProps {
  taskId: string
  tree: TaskTreeNode | null
  loading: boolean
}

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
}

const TreeNode = memo(function TreeNode({ node, currentTaskId, depth }: TreeNodeProps) {
  const { link, navigate } = useProjectNav()
  const [collapsed, setCollapsed] = useState(false)
  const isCurrent = node.taskId === currentTaskId
  const hasBranches = node.turns.some((t) => t.branches.length > 0)
  const isRunning = node.status === "running"

  const handleNodeClick = useCallback(() => {
    navigate(`/tasks/${node.taskId}`)
  }, [navigate, node.taskId])

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setCollapsed((v) => !v)
  }, [])

  return (
    <div className="flex flex-col">
      {/* Task header row */}
      <div
        className={`group flex cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-xs transition-colors hover:bg-muted ${isCurrent ? "bg-muted font-medium text-foreground" : "text-muted-foreground"}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={handleNodeClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleNodeClick() } }}
        title={node.title}
      >
        {hasBranches && (
          <button
            onClick={handleToggle}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={collapsed ? "Expand" : "Collapse"}
          >
            <svg
              className={`h-3 w-3 transition-transform ${collapsed ? "" : "rotate-90"}`}
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
      {!collapsed && node.turns.map((turn) => (
        <div key={turn.checkpointId}>
          {/* Turn row */}
          <a
            href={link(`/tasks/${node.taskId}`)}
            onClick={(e) => { e.preventDefault(); navigate(`/tasks/${node.taskId}`) }}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-2xs transition-colors hover:bg-muted/60 ${isCurrent ? "text-foreground/70" : "text-muted-foreground/60"}`}
            style={{ paddingLeft: `${8 + (depth + 1) * 16}px` }}
            title={turn.lastMessage || `Turn ${turn.turnIndex + 1}`}
          >
            <svg className="h-2.5 w-2.5 shrink-0 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span className="min-w-0 flex-1 truncate">
              {turn.lastMessage
                ? turn.lastMessage.slice(0, 60) + (turn.lastMessage.length > 60 ? "…" : "")
                : `Turn ${turn.turnIndex + 1}`}
            </span>
            <span className="shrink-0 text-muted-foreground/40">{formatTimestamp(turn.createdAt)}</span>
          </a>

          {/* Branches off this turn */}
          {turn.branches.length > 0 && (
            <div className="flex flex-col">
              {/* Fork indicator */}
              <div
                className="flex items-center gap-1.5 py-0.5 text-2xs text-muted-foreground/40"
                style={{ paddingLeft: `${8 + (depth + 1) * 16}px` }}
              >
                <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                </svg>
                <span>{turn.branches.length === 1 ? "1 branch" : `${turn.branches.length} branches`}</span>
              </div>
              {turn.branches.map((branch) => (
                <TreeNode
                  key={branch.taskId}
                  node={branch}
                  currentTaskId={currentTaskId}
                  depth={depth + 2}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
})

export function TreePane({ taskId, tree, loading }: TreePaneProps) {
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
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <svg className="h-3.5 w-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
        </svg>
        <span className="text-xs font-medium">Conversation tree</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        <TreeNode
          node={tree}
          currentTaskId={taskId}
          depth={0}
        />
      </div>
    </div>
  )
}
