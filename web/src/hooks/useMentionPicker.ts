import { useState, useCallback, useMemo, useRef } from "react"
import type { Task } from "@tangerine/shared"
import { formatTaskTitle } from "../lib/format"

export interface MentionPickerState {
  isOpen: boolean
  query: string
  selectedIndex: number
  /** Character index in textarea where the `@` trigger starts */
  triggerStart: number
}

export interface UseMentionPickerResult {
  state: MentionPickerState
  filteredTasks: Task[]
  /** Call on every text change with the full text and cursor position */
  onTextChange: (text: string, cursorPos: number) => void
  /** Handle keyboard events — returns true if the event was consumed */
  onKeyDown: (e: { key: string; preventDefault: () => void }) => boolean
  /** Select a task and return the new text with UUID inserted */
  selectTask: (task: Task, text: string) => { newText: string; cursorPos: number }
  /** Close the picker */
  close: () => void
  /** Set the selected index (e.g. on hover) */
  setSelectedIndex: (index: number) => void
}

const CLOSED: MentionPickerState = { isOpen: false, query: "", selectedIndex: 0, triggerStart: -1 }

export function useMentionPicker(tasks: Task[]): UseMentionPickerResult {
  const [state, setState] = useState<MentionPickerState>(CLOSED)
  // Ref to track filtered count for keyboard bounds without re-creating callbacks
  const filteredCountRef = useRef(0)

  const filteredTasks = useMemo(() => {
    if (!state.isOpen) return []
    const q = state.query.toLowerCase()
    return tasks
      .filter((t) => {
        const prNumber = t.prUrl?.match(/\/pull\/(\d+)/)?.[1] ?? ""
        return (
          formatTaskTitle(t.title, t.type).toLowerCase().includes(q) ||
          t.id.startsWith(q) ||
          (t.branch?.toLowerCase().includes(q) ?? false) ||
          (prNumber !== "" && (`#${prNumber}`.includes(q) || prNumber.includes(q)))
        )
      })
      .sort((a, b) => {
        // Active tasks first
        const aActive = a.status === "running" || a.status === "provisioning" || a.status === "created"
        const bActive = b.status === "running" || b.status === "provisioning" || b.status === "created"
        if (aActive !== bActive) return aActive ? -1 : 1
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      })
      .slice(0, 8)
  }, [tasks, state.isOpen, state.query])

  filteredCountRef.current = filteredTasks.length

  const close = useCallback(() => setState(CLOSED), [])

  const onTextChange = useCallback((text: string, cursorPos: number) => {
    // Scan backwards from cursor to find an unmatched `@`
    let i = cursorPos - 1
    while (i >= 0) {
      const ch = text[i]
      if (ch === "@") {
        // Only trigger after whitespace or at start-of-line to avoid false positives (e.g. email@domain)
        if (i > 0 && text[i - 1] !== " " && text[i - 1] !== "\n") break
        const query = text.slice(i + 1, cursorPos)
        if (query.includes("\n")) {
          setState(CLOSED)
          return
        }
        setState({ isOpen: true, query, selectedIndex: 0, triggerStart: i })
        return
      }
      // Stop at whitespace or newline before finding @
      if (ch === " " || ch === "\n") break
      i--
    }
    setState(CLOSED)
  }, [])

  const onKeyDown = useCallback((e: { key: string; preventDefault: () => void }): boolean => {
    if (!state.isOpen) return false

    if (e.key === "Escape") {
      e.preventDefault()
      setState(CLOSED)
      return true
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setState((s) => ({
        ...s,
        selectedIndex: Math.min(s.selectedIndex + 1, filteredCountRef.current - 1),
      }))
      return true
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setState((s) => ({
        ...s,
        selectedIndex: Math.max(s.selectedIndex - 1, 0),
      }))
      return true
    }
    // Enter/Tab are handled by the caller only when there's a valid selection
    return false
  }, [state.isOpen])

  const selectTask = useCallback((task: Task, text: string): { newText: string; cursorPos: number } => {
    const { triggerStart } = state
    const beforeMention = text.slice(0, triggerStart)
    const afterQuery = text.slice(triggerStart + 1 + state.query.length)
    const uuid = task.id
    const newText = `${beforeMention}${uuid}${afterQuery}`
    const cursorPos = beforeMention.length + uuid.length
    setState(CLOSED)
    return { newText, cursorPos }
  }, [state])

  const setSelectedIndex = useCallback((index: number) => {
    setState((s) => ({ ...s, selectedIndex: index }))
  }, [])

  return { state, filteredTasks, onTextChange, onKeyDown, selectTask, close, setSelectedIndex }
}
