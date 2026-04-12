import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import type { Task } from "@tangerine/shared"
import { fetchTasks } from "../lib/api"
import { getStatusConfig } from "../lib/status"
import { formatRelativeTime, formatTaskTitle } from "../lib/format"
import { getRecentTasks, RECENT_TASK_STATUSES } from "../lib/task-recency"
import { Search, X } from "lucide-react"
import {
  getActions,
  executeAction,
  formatShortcut,
  registerActions,
  subscribe,
  type Action,
} from "../lib/actions"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"

function fuzzyScore(str: string, query: string): number {
  if (!query) return 1
  const s = str.toLowerCase()
  const q = query.toLowerCase()
  let si = 0
  let qi = 0
  let score = 0
  let consecutive = 0
  while (si < s.length && qi < q.length) {
    if (s[si] === q[qi]) {
      consecutive++
      score += consecutive
      qi++
    } else {
      consecutive = 0
    }
    si++
  }
  return qi === q.length ? score : 0
}

type PaletteMode = "mixed" | "actions"

interface PaletteItem {
  type: "action" | "task"
  action?: Action
  task?: Task
  score: number
}

function TaskResult({ task, isSelected }: { task: Task; isSelected: boolean }) {
  const statusConfig = getStatusConfig(task.status)
  const isIdleRunning = task.status === "running" && task.agentStatus === "idle"
  const dotColor = isIdleRunning ? "var(--color-status-warning)" : statusConfig.color
  const statusLabel = isIdleRunning ? "idle" : statusConfig.label
  return (
    <div
      className={`flex w-full items-center gap-snug px-normal py-2.5 text-left transition-colors ${
        isSelected ? "bg-muted" : ""
      }`}
    >
      <div
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: dotColor }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-md font-medium text-foreground">{formatTaskTitle(task)}</p>
        <p className="truncate text-xxs text-muted-foreground">{task.projectId}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {task.type !== "worker" && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
            {task.type}
          </span>
        )}
        <span
          className={`rounded px-1.5 py-0.5 text-2xs font-medium ${statusConfig.bgClass} ${statusConfig.textClass}`}
        >
          {statusLabel}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-xxs text-muted-foreground">{task.id.slice(0, 8)}</span>
        <span className="text-xxs text-muted-foreground">{formatRelativeTime(task.updatedAt)}</span>
      </div>
    </div>
  )
}

function ActionResult({ action, isSelected }: { action: Action; isSelected: boolean }) {
  return (
    <div
      className={`flex w-full items-center gap-snug px-normal py-2.5 text-left transition-colors ${
        isSelected ? "bg-muted" : ""
      }`}
    >
      <div className="flex h-5 w-5 shrink-0 items-center justify-center">
        <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-md font-medium text-foreground">{action.label}</p>
        {action.description && (
          <p className="truncate text-xxs text-muted-foreground">{action.description}</p>
        )}
      </div>
      {action.section && (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
          {action.section}
        </span>
      )}
      {action.shortcut && (
        <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
          {formatShortcut(action.shortcut)}
        </kbd>
      )}
    </div>
  )
}

export function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [actions, setActions] = useState<Action[]>(getActions)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  // Register palette actions. palette.open is idempotent (used by pull-to-refresh etc.).
  // palette.toggle handles the Cmd+K shortcut via useShortcuts.
  useEffect(() => {
    const unregister = registerActions([
      {
        id: "palette.open",
        label: "Open command palette",
        hidden: true,
        handler: () => setIsOpen(true),
      },
      {
        id: "palette.toggle",
        label: "Toggle command palette",
        hidden: true,
        handler: () => setIsOpen((prev) => !prev),
      },
    ])
    return unregister
  }, [])

  // Sync actions from registry
  useEffect(() => {
    const unsub = subscribe(() => setActions(getActions()))
    return unsub
  }, [])

  // Fetch tasks and reset state when opened
  useEffect(() => {
    if (!isOpen) return
    setQuery("")
    setSelectedIndex(0)
    fetchTasks().then(setTasks).catch(() => {})
  }, [isOpen])

  // Auto-focus input when opened
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [isOpen])

  const close = useCallback(() => setIsOpen(false), [])

  // Determine mode: ">" prefix = actions only, otherwise mixed
  const mode: PaletteMode = query.startsWith(">") ? "actions" : "mixed"
  const searchQuery = mode === "actions" ? query.slice(1).trim() : query.trim()

  const items = useMemo((): PaletteItem[] => {
    const result: PaletteItem[] = []

    // Filter actions (always, unless we have no query in mixed mode — then show actions as suggestions)
    const visibleActions = actions.filter((a) => !a.hidden)

    if (mode === "actions" || searchQuery) {
      for (const a of visibleActions) {
        const score = searchQuery ? fuzzyScore(a.label, searchQuery) : 1
        if (score > 0) {
          result.push({ type: "action", action: a, score: score * 2 })
        }
      }
    }

    // Include tasks in mixed mode
    if (mode === "mixed") {
      if (!searchQuery) {
        // No query: show active tasks sorted by recency, then all actions
        const activeTasks = getRecentTasks(tasks)
        for (const t of activeTasks) {
          result.push({ type: "task", task: t, score: 0 })
        }
        // Add actions after tasks
        for (const a of visibleActions) {
          result.push({ type: "action", action: a, score: 0 })
        }
        return result
      }
      // With query: fuzzy match tasks
      for (const t of tasks) {
        const prNumber = t.prUrl?.match(/\/pull\/(\d+)/)?.[1] ?? ""
        const score = Math.max(
          fuzzyScore(formatTaskTitle(t), searchQuery) * 3,
          fuzzyScore(t.projectId, searchQuery) * 2,
          fuzzyScore(t.id, searchQuery),
          fuzzyScore(t.branch ?? "", searchQuery) * 2,
          fuzzyScore(prNumber ? `#${prNumber}` : "", searchQuery) * 2,
          fuzzyScore(prNumber, searchQuery) * 2,
        )
        if (score > 0) {
          const activeBonus = RECENT_TASK_STATUSES.has(t.status) ? 1000 : 0
          result.push({ type: "task", task: t, score: score + activeBonus })
        }
      }
    }

    // Sort by score descending
    result.sort((a, b) => b.score - a.score)
    return result
  }, [actions, tasks, searchQuery, mode])

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [items.length, query])

  // Scroll selected item into view
  useEffect(() => {
    const item = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  const handleSelectTask = useCallback(
    (task: Task) => {
      navigate(`/tasks/${task.id}?project=${encodeURIComponent(task.projectId)}`)
      close()
    },
    [navigate, close],
  )

  const handleSelectAction = useCallback(
    (action: Action) => {
      close()
      executeAction(action.id)
    },
    [close],
  )

  const handleSelect = useCallback(
    (item: PaletteItem) => {
      if (item.type === "task" && item.task) {
        handleSelectTask(item.task)
      } else if (item.type === "action" && item.action) {
        handleSelectAction(item.action)
      }
    },
    [handleSelectTask, handleSelectAction],
  )

  // Overlay keyboard navigation
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close()
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === "Enter") {
        const item = items[selectedIndex]
        if (item) handleSelect(item)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [isOpen, items, selectedIndex, handleSelect, close])

  if (!isOpen) return null

  const placeholder = mode === "actions" ? "Search actions..." : "Search tasks and actions..."

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh] bg-black/60"
      onClick={close}
    >
      <div
        className="mx-4 w-full max-w-xl overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <InputGroup className="rounded-none border-0 border-b border-border">
          <InputGroupInput
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            className="py-3.5 text-sm"
          />
          <InputGroupAddon className="pl-normal">
            <Search className="size-4" />
          </InputGroupAddon>
          {query && (
            <InputGroupAddon align="inline-end" className="pr-normal">
              <InputGroupButton
                size="icon-xs"
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                <X className="size-4" />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>

        {/* Results list */}
        <div ref={listRef} className="max-h-[400px] overflow-y-auto py-1">
          {items.length === 0 ? (
            <div className="px-normal py-loose text-center text-md text-muted-foreground">
              {searchQuery ? "No results" : "No active tasks"}
            </div>
          ) : (
            items.map((item, i) => {
              const isSelected = i === selectedIndex
              const key = item.type === "task" ? `task-${item.task!.id}` : `action-${item.action!.id}`
              return (
                <button
                  key={key}
                  onClick={() => handleSelect(item)}
                  onMouseMove={() => setSelectedIndex(i)}
                  className="w-full"
                >
                  {item.type === "task" ? (
                    <TaskResult task={item.task!} isSelected={isSelected} />
                  ) : (
                    <ActionResult action={item.action!} isSelected={isSelected} />
                  )}
                </button>
              )
            })
          )}
        </div>

        {/* Footer shortcuts hint */}
        <div className="flex items-center gap-snug border-t border-border px-normal py-tight text-xxs text-muted-foreground">
          <span>
            <kbd className="font-sans">↵</kbd> select
          </span>
          <span>
            <kbd className="font-sans">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-sans">esc</kbd> close
          </span>
          <span>
            <kbd className="font-sans">&gt;</kbd> actions
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
