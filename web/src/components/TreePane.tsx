import { memo, useState, useCallback, useRef, useEffect, useMemo } from "react"
import type { TaskTree, TreeTurn, TaskMeta, Checkpoint } from "@tangerine/shared"
import { getStatusConfig } from "../lib/status"
import { useProjectNav } from "../hooks/useProjectNav"
import { formatTimestamp } from "../lib/format"

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

interface TurnRowProps {
  turn: TreeTurn
  task: TaskMeta
  prefix: string
  isFirstTurnOfTask: boolean
  currentTaskId: string
  isFocused: boolean
  onFocus: (id: string) => void
  nodeRefs: React.MutableRefObject<Map<string, HTMLElement>>
  search: string
  checkpoint?: Checkpoint
  onBranch?: (checkpoint: Checkpoint) => void
}

const TurnRow = memo(function TurnRow({
  turn,
  task,
  prefix,
  isFirstTurnOfTask,
  currentTaskId,
  isFocused,
  onFocus,
  nodeRefs,
  search,
  checkpoint,
  onBranch,
}: TurnRowProps) {
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

  const visible = !search ||
    task.title.toLowerCase().includes(search.toLowerCase()) ||
    (turn.message ?? "").toLowerCase().includes(search.toLowerCase())

  const TurnEl = isCurrent ? "div" : "a"
  const turnLinkProps = isCurrent
    ? {}
    : {
        href: link(`/tasks/${turn.taskId}`),
        onClick: (e: React.MouseEvent) => { e.preventDefault(); navigate(`/tasks/${turn.taskId}`) },
      }

  return (
    <TurnEl
      ref={setRef as React.RefCallback<HTMLElement>}
      {...turnLinkProps}
      onFocus={(e) => { if (e.target === e.currentTarget) onFocus(nodeId) }}
      className={`group/turn flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors ${isCurrent ? "bg-muted/50 text-foreground" : "cursor-pointer touch-manipulation hover:bg-muted active:bg-muted text-muted-foreground"} ${isFocused ? "ring-1 ring-ring" : ""} ${!visible ? "opacity-30" : ""}`}
      tabIndex={isFocused ? 0 : -1}
      role="treeitem"
      title={turn.message || `Turn ${turn.turnIndex + 1}`}
    >
      {prefix && <span className="shrink-0 font-mono text-muted-foreground/40 text-2xs whitespace-pre">{prefix}</span>}
      {isFirstTurnOfTask && (
        <>
          <StatusDot status={task.status} />
          <span className="shrink-0 max-w-[80px] truncate text-2xs font-medium">{task.title}</span>
          <span className="text-muted-foreground/30">·</span>
        </>
      )}
      <span className="min-w-0 flex-1 truncate">
        {turn.turnIndex < 0
          ? <span className="italic text-muted-foreground/50">Starting…</span>
          : turn.message
            ? turn.message.slice(0, 60) + (turn.message.length > 60 ? "…" : "")
            : `Turn ${turn.turnIndex + 1}`}
      </span>
      {checkpoint && onBranch && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); onBranch(checkpoint) }}
          className="shrink-0 rounded px-1.5 py-0.5 text-2xs text-muted-foreground md:opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 focus-visible:ring-1 focus-visible:ring-ring md:group-hover/turn:opacity-100"
          title="Branch from this turn"
          aria-label="Branch from this turn"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
          </svg>
        </button>
      )}
      <span className={`shrink-0 text-2xs text-muted-foreground/40 ${checkpoint && onBranch ? "hidden md:inline md:group-hover/turn:hidden" : ""}`}>
        {formatTimestamp(turn.createdAt)}
      </span>
    </TurnEl>
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

  const turns = tree?.turns ?? []
  const tasks = tree?.tasks ?? {}

  const treeData = useMemo(() => {
    // Group turns by task
    const turnsByTask = new Map<string, TreeTurn[]>()
    for (const turn of turns) {
      const existing = turnsByTask.get(turn.taskId)
      if (existing) existing.push(turn)
      else turnsByTask.set(turn.taskId, [turn])
    }

    // Build task branch tree: which tasks branch from which checkpoint
    const tasksByBranchPoint = new Map<string | null, string[]>()
    for (const [tid, taskTurns] of turnsByTask) {
      const firstTurn = taskTurns[0]
      const branchPoint = firstTurn?.parentCheckpointId ?? null
      const existing = tasksByBranchPoint.get(branchPoint)
      if (existing) existing.push(tid)
      else tasksByBranchPoint.set(branchPoint, [tid])
    }

    const result: Array<{ turn: TreeTurn; prefix: string; isFirstTurnOfTask: boolean }> = []
    const activeLines = new Set<number>()

    function walkTask(tid: string, isLastTask: boolean) {
      const taskTurns = turnsByTask.get(tid) ?? []
      const level = taskTurns[0]?.level ?? 1

      taskTurns.forEach((turn, turnIdx) => {
        const isFirstTurn = turnIdx === 0
        const isLastTurn = turnIdx === taskTurns.length - 1

        // Check if any child tasks branch from this turn's checkpoint
        const childTasks = tasksByBranchPoint.get(turn.checkpointId) ?? []
        const hasChildren = childTasks.length > 0

        let prefix = ""
        for (let l = 1; l < level; l++) {
          prefix += activeLines.has(l) ? "│  " : "   "
        }

        if (level > 1) {
          if (isFirstTurn) {
            // First turn of task gets branch connector
            prefix += isLastTask ? "└─ " : "├─ "
          } else {
            // Subsequent turns get continuation line
            prefix += "│  "
          }
        }

        // Update active lines for children
        if (isLastTurn && isLastTask) activeLines.delete(level)
        else if (isFirstTurn && !isLastTask) activeLines.add(level)

        result.push({ turn, prefix, isFirstTurnOfTask: isFirstTurn })

        // After last turn of this task, recurse into child tasks
        if (isLastTurn && hasChildren) {
          activeLines.add(level)
          childTasks.forEach((childTid, idx) => {
            walkTask(childTid, idx === childTasks.length - 1)
          })
          activeLines.delete(level)
        }
      })
    }

    // Start with root tasks (no parent checkpoint)
    const rootTasks = tasksByBranchPoint.get(null) ?? []
    rootTasks.forEach((tid, idx) => {
      walkTask(tid, idx === rootTasks.length - 1)
    })

    return result
  }, [turns])

  useEffect(() => {
    if (focusedId) {
      nodeRefs.current.get(focusedId)?.focus({ preventScroll: false })
    }
  }, [focusedId])

  useEffect(() => {
    if (!tree || treeData.length === 0) return
    const current = treeData.find(({ turn }) => turn.taskId === taskId)
    if (current) {
      setFocusedId(`turn:${current.turn.taskId}:${current.turn.turnIndex}`)
    }
  }, [tree, taskId, treeData])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (document.activeElement === searchRef.current) {
        if (e.key === "Escape") {
          setSearch("")
          searchRef.current?.blur()
        }
        return
      }

      const currentIndex = treeData.findIndex(({ turn }) => `turn:${turn.taskId}:${turn.turnIndex}` === focusedId)

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault()
          const next = treeData[currentIndex + 1]
          if (next) setFocusedId(`turn:${next.turn.taskId}:${next.turn.turnIndex}`)
          break
        }
        case "ArrowUp": {
          e.preventDefault()
          if (currentIndex <= 0) {
            searchRef.current?.focus()
          } else {
            const prev = treeData[currentIndex - 1]
            if (prev) setFocusedId(`turn:${prev.turn.taskId}:${prev.turn.turnIndex}`)
          }
          break
        }
        case "ArrowLeft": {
          e.preventDefault()
          const cur = treeData[currentIndex]
          if (cur && cur.turn.parentCheckpointId) {
            const parent = treeData.find(({ turn }) => turn.checkpointId === cur.turn.parentCheckpointId)
            if (parent) setFocusedId(`turn:${parent.turn.taskId}:${parent.turn.turnIndex}`)
          }
          break
        }
        case "Enter": {
          e.preventDefault()
          const cur = treeData[currentIndex]
          if (cur && cur.turn.taskId !== taskId) navigate(`/tasks/${cur.turn.taskId}`)
          break
        }
        case "/": {
          e.preventDefault()
          searchRef.current?.focus()
          break
        }
      }
    },
    [treeData, focusedId, navigate, taskId],
  )

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading tree…
      </div>
    )
  }

  if (!tree || turns.length === 0) {
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
              const first = treeData[0]
              if (first) { setFocusedId(`turn:${first.turn.taskId}:${first.turn.turnIndex}`); e.currentTarget.blur() }
            }
          }}
          placeholder="Filter… (/)"
          className="w-full rounded border border-border bg-background px-2 py-1 text-2xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
          aria-label="Filter tree nodes"
        />
      </div>

      <div className="flex-1 touch-pan-y overflow-y-auto py-1">
        {treeData.map(({ turn, prefix, isFirstTurnOfTask }) => {
          const task = tasks[turn.taskId]
          if (!task) return null
          const checkpoint = turn.taskId === taskId ? checkpointMap.get(turn.checkpointId) : undefined
          return (
            <TurnRow
              key={turn.checkpointId}
              turn={turn}
              task={task}
              prefix={prefix}
              isFirstTurnOfTask={isFirstTurnOfTask}
              currentTaskId={taskId}
              isFocused={focusedId === `turn:${turn.taskId}:${turn.turnIndex}`}
              onFocus={setFocusedId}
              nodeRefs={nodeRefs}
              search={search}
              checkpoint={checkpoint}
              onBranch={onBranch}
            />
          )
        })}
      </div>

      <div className="border-t border-border px-3 py-1.5 text-2xs text-muted-foreground/40">
        ↑↓ navigate · ← parent · Enter select · / search
      </div>
    </div>
  )
}
