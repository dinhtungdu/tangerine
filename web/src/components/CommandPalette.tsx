import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import type { Task } from "@tangerine/shared"
import { fetchTasks } from "../lib/api"
import { getStatusConfig } from "../lib/status"
import { formatRelativeTime } from "../lib/format"
import {
  getActions,
  executeAction,
  formatShortcut,
  registerActions,
  subscribe,
  type Action,
} from "../lib/actions"

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

const ACTIVE_STATUSES = new Set(["running", "provisioning", "created"])

type PaletteMode = "mixed" | "actions"

interface PaletteItem {
  type: "action" | "task"
  action?: Action
  task?: Task
  score: number
}

function TaskResult({ task, isSelected }: { task: Task; isSelected: boolean }) {
  const statusConfig = getStatusConfig(task.status)
  return (
    <div
      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
        isSelected ? "bg-surface-secondary" : ""
      }`}
    >
      <div
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: statusConfig.color }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-md font-medium text-fg">{task.title}</p>
        <p className="truncate text-xxs text-fg-muted">{task.projectId}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {task.type !== "worker" && (
          <span className="rounded bg-surface-dark px-1.5 py-0.5 text-2xs font-medium text-fg-muted">
            {task.type}
          </span>
        )}
        <span
          className={`rounded px-1.5 py-0.5 text-2xs font-medium ${statusConfig.bgClass} ${statusConfig.textClass}`}
        >
          {statusConfig.label}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-xxs text-fg-muted">{task.id.slice(0, 8)}</span>
        <span className="text-xxs text-fg-muted">{formatRelativeTime(task.updatedAt)}</span>
      </div>
    </div>
  )
}

function ActionResult({ action, isSelected }: { action: Action; isSelected: boolean }) {
  return (
    <div
      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
        isSelected ? "bg-surface-secondary" : ""
      }`}
    >
      <div className="flex h-5 w-5 shrink-0 items-center justify-center">
        <svg className="h-4 w-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-md font-medium text-fg">{action.label}</p>
        {action.description && (
          <p className="truncate text-xxs text-fg-muted">{action.description}</p>
        )}
      </div>
      {action.section && (
        <span className="shrink-0 rounded bg-surface-dark px-1.5 py-0.5 text-2xs font-medium text-fg-muted">
          {action.section}
        </span>
      )}
      {action.shortcut && (
        <kbd className="shrink-0 rounded border border-edge bg-surface-dark px-1.5 py-0.5 font-mono text-2xs text-fg-muted">
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

  // Register palette.open action so external callers (pull-to-refresh) can open it.
  // No shortcut here — Cmd+K is handled by the direct listener below to avoid double-fire.
  useEffect(() => {
    const unregister = registerActions([
      {
        id: "palette.open",
        label: "Open command palette",
        hidden: true,
        handler: () => setIsOpen(true),
      },
    ])
    return unregister
  }, [])

  // Sync actions from registry
  useEffect(() => {
    const unsub = subscribe(() => setActions(getActions()))
    return unsub
  }, [])

  // Direct Cmd+K / Ctrl+K toggle — works without useShortcuts being mounted
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key === "k")) return
      e.preventDefault()
      setIsOpen((prev) => !prev)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
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
        const activeTasks = tasks
          .filter((t) => ACTIVE_STATUSES.has(t.status))
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
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
        const score = Math.max(
          fuzzyScore(t.title, searchQuery) * 3,
          fuzzyScore(t.projectId, searchQuery) * 2,
          fuzzyScore(t.id, searchQuery),
        )
        if (score > 0) {
          const activeBonus = ACTIVE_STATUSES.has(t.status) ? 1000 : 0
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
        className="mx-4 w-full max-w-xl overflow-hidden rounded-xl border border-edge bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-edge px-4">
          <svg
            className="h-4 w-4 shrink-0 text-fg-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            className="w-full bg-transparent py-3.5 text-sm text-fg placeholder:text-fg-muted outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="shrink-0 text-fg-muted hover:text-fg"
              aria-label="Clear search"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Results list */}
        <div ref={listRef} className="max-h-[400px] overflow-y-auto py-1">
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-md text-fg-muted">
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
        <div className="flex items-center gap-3 border-t border-edge px-4 py-2 text-xxs text-fg-muted">
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
