import { memo, useState, useCallback, useRef, useEffect, useMemo } from "react"
import type { TaskTree, TreeTurn, TaskMeta, Checkpoint } from "@tangerine/shared"
import { getStatusConfig } from "../lib/status"
import { useProjectNav } from "../hooks/useProjectNav"

interface TreePaneProps {
  taskId: string
  tree: TaskTree | null
  loading: boolean
  checkpoints?: Checkpoint[]
  onBranch?: (checkpoint: Checkpoint) => void
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

interface TaskNode {
  task: TaskMeta
  turns: TreeTurn[]
  children: TaskNode[]
}

function buildTaskTree(tree: TaskTree): TaskNode | null {
  const { turns, tasks } = tree
  const taskIds = Object.keys(tasks)
  if (taskIds.length === 0) return null

  const turnsByTask = new Map<string, TreeTurn[]>()
  for (const turn of turns) {
    const existing = turnsByTask.get(turn.taskId) ?? []
    existing.push(turn)
    turnsByTask.set(turn.taskId, existing)
  }

  const childrenByParent = new Map<string, string[]>()
  let rootId: string | null = null

  for (const taskId of taskIds) {
    const task = tasks[taskId]
    if (!task) continue
    if (task.parentTaskId && tasks[task.parentTaskId]) {
      const siblings = childrenByParent.get(task.parentTaskId) ?? []
      siblings.push(taskId)
      childrenByParent.set(task.parentTaskId, siblings)
    } else {
      rootId = taskId
    }
  }

  if (!rootId) return null

  function buildNode(taskId: string): TaskNode {
    const task = tasks[taskId]!
    const taskTurns = turnsByTask.get(taskId) ?? []
    const childIds = childrenByParent.get(taskId) ?? []
    taskTurns.sort((a, b) => a.turnIndex - b.turnIndex)
    childIds.sort((a, b) => {
      const aTurns = turnsByTask.get(a) ?? []
      const bTurns = turnsByTask.get(b) ?? []
      return (aTurns[0]?.createdAt ?? "").localeCompare(bTurns[0]?.createdAt ?? "")
    })
    return {
      task,
      turns: taskTurns,
      children: childIds.map(buildNode),
    }
  }

  return buildNode(rootId)
}

interface TurnChipProps {
  turn: TreeTurn
  currentTaskId: string
  isFocused: boolean
  onFocus: (id: string) => void
  nodeRefs: React.MutableRefObject<Map<string, HTMLElement>>
  checkpoint?: Checkpoint
  onBranch?: (checkpoint: Checkpoint) => void
}

const TurnChip = memo(function TurnChip({
  turn,
  currentTaskId,
  isFocused,
  onFocus,
  nodeRefs,
  checkpoint,
  onBranch,
}: TurnChipProps) {
  const { link, navigate } = useProjectNav()
  const isCurrent = turn.taskId === currentTaskId
  const nodeId = `turn:${turn.taskId}:${turn.turnIndex}`

  const setRef = useCallback(
    (el: HTMLElement | null) => {
      if (el) nodeRefs.current.set(nodeId, el)
      else nodeRefs.current.delete(nodeId)
    },
    [nodeRefs, nodeId],
  )

  const TurnEl = isCurrent ? "div" : "a"
  const turnLinkProps = isCurrent
    ? {}
    : {
        href: link(`/tasks/${turn.taskId}`),
        onClick: (e: React.MouseEvent) => { e.preventDefault(); navigate(`/tasks/${turn.taskId}`) },
      }

  const label = turn.turnIndex < 0
    ? "…"
    : turn.message
      ? turn.message.slice(0, 20) + (turn.message.length > 20 ? "…" : "")
      : `t${turn.turnIndex}`

  return (
    <TurnEl
      ref={setRef as React.RefCallback<HTMLElement>}
      {...turnLinkProps}
      onFocus={(e) => { if (e.target === e.currentTarget) onFocus(nodeId) }}
      className={`group/turn relative flex items-center gap-0.5 rounded px-1.5 py-0.5 text-2xs whitespace-nowrap transition-colors ${isCurrent ? "bg-primary/20 text-foreground" : "cursor-pointer touch-manipulation hover:bg-muted active:bg-muted text-muted-foreground"} ${isFocused ? "ring-1 ring-ring" : ""}`}
      tabIndex={isFocused ? 0 : -1}
      role="treeitem"
      title={turn.message || `Turn ${turn.turnIndex + 1}`}
    >
      <span className="truncate max-w-[80px]">{label}</span>
      {checkpoint && onBranch && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); onBranch(checkpoint) }}
          className="shrink-0 rounded px-0.5 text-muted-foreground/50 hover:text-foreground"
          title="Branch"
          aria-label="Branch from this turn"
        >
          +
        </button>
      )}
    </TurnEl>
  )
})

interface TaskRowProps {
  node: TaskNode
  currentTaskId: string
  focusedId: string | null
  onFocus: (id: string) => void
  nodeRefs: React.MutableRefObject<Map<string, HTMLElement>>
  checkpointMap: Map<string, Checkpoint>
  onBranch?: (checkpoint: Checkpoint) => void
  isLast: boolean
  connectorPrefix: string
}

const TaskRow = memo(function TaskRow({
  node,
  currentTaskId,
  focusedId,
  onFocus,
  nodeRefs,
  checkpointMap,
  onBranch,
  isLast,
  connectorPrefix,
}: TaskRowProps) {
  const { task, turns, children } = node
  const isCurrent = task.taskId === currentTaskId

  const connector = connectorPrefix + (isLast ? "└─" : "├─")
  const childPrefix = connectorPrefix + (isLast ? "  " : "│ ")

  return (
    <>
      <div className="flex items-center gap-1 py-0.5">
        {connectorPrefix && (
          <span className="font-mono text-2xs text-muted-foreground/30 whitespace-pre select-none">
            {connector}
          </span>
        )}
        <div className={`flex items-center gap-1 rounded px-1 py-0.5 ${isCurrent ? "bg-muted" : ""}`}>
          <StatusDot status={task.status} />
          <span className={`text-2xs font-medium truncate max-w-[100px] ${isCurrent ? "text-foreground" : "text-muted-foreground"}`}>
            {task.title}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {turns.map((turn, i) => (
            <span key={turn.checkpointId} className="flex items-center gap-0.5">
              {i > 0 && <span className="text-muted-foreground/30 text-2xs">→</span>}
              <TurnChip
                turn={turn}
                currentTaskId={currentTaskId}
                isFocused={focusedId === `turn:${turn.taskId}:${turn.turnIndex}`}
                onFocus={onFocus}
                nodeRefs={nodeRefs}
                checkpoint={turn.taskId === currentTaskId ? checkpointMap.get(turn.checkpointId) : undefined}
                onBranch={onBranch}
              />
            </span>
          ))}
        </div>
        {children.length > 0 && (
          <span className="text-muted-foreground/30 text-2xs">──┬</span>
        )}
      </div>
      {children.map((child, i) => (
        <TaskRow
          key={child.task.taskId}
          node={child}
          currentTaskId={currentTaskId}
          focusedId={focusedId}
          onFocus={onFocus}
          nodeRefs={nodeRefs}
          checkpointMap={checkpointMap}
          onBranch={onBranch}
          isLast={i === children.length - 1}
          connectorPrefix={childPrefix}
        />
      ))}
    </>
  )
})

export function TreePane({ taskId, tree, loading, checkpoints, onBranch }: TreePaneProps) {
  const { navigate } = useProjectNav()
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const checkpointMap = useMemo(
    () => new Map(checkpoints?.map((cp) => [cp.id, cp]) ?? []),
    [checkpoints],
  )

  const rootNode = useMemo(() => tree ? buildTaskTree(tree) : null, [tree])
  const turns = tree?.turns ?? []

  useEffect(() => {
    if (focusedId) {
      nodeRefs.current.get(focusedId)?.focus({ preventScroll: false })
    }
  }, [focusedId])

  useEffect(() => {
    if (!tree || turns.length === 0) return
    const currentTurn = turns.find((t) => t.taskId === taskId)
    if (currentTurn) {
      setFocusedId(`turn:${currentTurn.taskId}:${currentTurn.turnIndex}`)
    }
  }, [tree, taskId, turns])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (document.activeElement === searchRef.current) {
        if (e.key === "Escape") {
          setSearch("")
          searchRef.current?.blur()
        }
        return
      }

      const currentIndex = turns.findIndex((t) => `turn:${t.taskId}:${t.turnIndex}` === focusedId)

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault()
          const next = turns[currentIndex + 1]
          if (next) setFocusedId(`turn:${next.taskId}:${next.turnIndex}`)
          break
        }
        case "ArrowUp": {
          e.preventDefault()
          if (currentIndex <= 0) {
            searchRef.current?.focus()
          } else {
            const prev = turns[currentIndex - 1]
            if (prev) setFocusedId(`turn:${prev.taskId}:${prev.turnIndex}`)
          }
          break
        }
        case "ArrowLeft": {
          e.preventDefault()
          const cur = turns[currentIndex]
          if (cur && cur.parentCheckpointId) {
            const parent = turns.find((t) => t.checkpointId === cur.parentCheckpointId)
            if (parent) setFocusedId(`turn:${parent.taskId}:${parent.turnIndex}`)
          }
          break
        }
        case "Enter": {
          e.preventDefault()
          const cur = turns[currentIndex]
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
    [turns, focusedId, navigate, taskId],
  )

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading tree…
      </div>
    )
  }

  if (!tree || !rootNode) {
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
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <svg className="h-3.5 w-3.5 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
        </svg>
        <span className="text-xs font-medium">Conversation tree</span>
      </div>

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
              const first = turns[0]
              if (first) { setFocusedId(`turn:${first.taskId}:${first.turnIndex}`); e.currentTarget.blur() }
            }
          }}
          placeholder="Filter… (/)"
          className="w-full rounded border border-border bg-background px-2 py-1 text-2xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
          aria-label="Filter tree nodes"
        />
      </div>

      <div className="flex-1 touch-pan-y overflow-auto p-2">
        <TaskRow
          node={rootNode}
          currentTaskId={taskId}
          focusedId={focusedId}
          onFocus={setFocusedId}
          nodeRefs={nodeRefs}
          checkpointMap={checkpointMap}
          onBranch={onBranch}
          isLast={true}
          connectorPrefix=""
        />
      </div>

      <div className="border-t border-border px-3 py-1.5 text-2xs text-muted-foreground/40">
        ↑↓ navigate · ← parent · Enter select · / search
      </div>
    </div>
  )
}
