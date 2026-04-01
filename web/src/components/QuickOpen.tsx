import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import type { Task } from "@tangerine/shared"
import { fetchTasks } from "../lib/api"
import { getStatusConfig } from "../lib/status"
import { formatRelativeTime } from "../lib/format"

// Returns a score > 0 if all query chars appear in str as a subsequence.
// Consecutive character matches add a higher bonus, rewarding tighter matches.
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

export function QuickOpen() {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  // Global Cmd+K / Ctrl+K to open — always activates regardless of focus
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

  const filtered = useMemo(() => {
    if (!query.trim()) {
      return tasks
        .filter((t) => ACTIVE_STATUSES.has(t.status))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    }
    const q = query.trim()
    return tasks
      .map((t) => {
        // Weight title matches highest, then project, then id
        const score = Math.max(
          fuzzyScore(t.title, q) * 3,
          fuzzyScore(t.projectId, q) * 2,
          fuzzyScore(t.id, q),
        )
        return { task: t, score }
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => {
        const aActive = ACTIVE_STATUSES.has(a.task.status) ? 1 : 0
        const bActive = ACTIVE_STATUSES.has(b.task.status) ? 1 : 0
        if (bActive !== aActive) return bActive - aActive
        if (b.score !== a.score) return b.score - a.score
        return new Date(b.task.updatedAt).getTime() - new Date(a.task.updatedAt).getTime()
      })
      .map(({ task }) => task)
  }, [tasks, query])

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [filtered.length, query])

  // Scroll selected item into view
  useEffect(() => {
    const item = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  const handleSelect = useCallback(
    (task: Task) => {
      // Always switch to the task's own project so TaskDetail loads the right context
      navigate(`/tasks/${task.id}?project=${encodeURIComponent(task.projectId)}`)
      close()
    },
    [navigate, close],
  )

  // Overlay keyboard navigation (Escape, Arrow Up/Down, Enter)
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close()
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === "Enter") {
        const task = filtered[selectedIndex]
        if (task) handleSelect(task)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [isOpen, filtered, selectedIndex, handleSelect, close])

  if (!isOpen) return null

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
            placeholder="Search tasks..."
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
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-md text-fg-muted">
              {query ? "No matching tasks" : "No active tasks"}
            </div>
          ) : (
            filtered.map((task, i) => {
              const statusConfig = getStatusConfig(task.status)
              const isSelected = i === selectedIndex
              return (
                <button
                  key={task.id}
                  onClick={() => handleSelect(task)}
                  onMouseMove={() => setSelectedIndex(i)}
                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                    isSelected ? "bg-surface-secondary" : ""
                  }`}
                >
                  {/* Status dot */}
                  <div
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: statusConfig.color }}
                  />

                  {/* Title + project name */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-md font-medium text-fg">{task.title}</p>
                    <p className="truncate text-xxs text-fg-muted">{task.projectId}</p>
                  </div>

                  {/* Type badge (only for non-worker tasks) */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    {task.type !== "worker" && (
                      <span className="rounded bg-surface-dark px-1.5 py-0.5 text-2xs font-medium text-fg-muted">
                        {task.type}
                      </span>
                    )}
                    {/* Status badge */}
                    <span
                      className={`rounded px-1.5 py-0.5 text-2xs font-medium ${statusConfig.bgClass} ${statusConfig.textClass}`}
                    >
                      {statusConfig.label}
                    </span>
                  </div>

                  {/* Short ID + time ago */}
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <span className="font-mono text-xxs text-fg-muted">{task.id.slice(0, 8)}</span>
                    <span className="text-xxs text-fg-muted">{formatRelativeTime(task.updatedAt)}</span>
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* Footer shortcuts hint */}
        <div className="flex items-center gap-3 border-t border-edge px-4 py-2 text-xxs text-fg-muted">
          <span>
            <kbd className="font-sans">↵</kbd> open
          </span>
          <span>
            <kbd className="font-sans">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-sans">esc</kbd> close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
