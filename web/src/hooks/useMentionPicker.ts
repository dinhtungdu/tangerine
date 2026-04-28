import { useState, useCallback, useMemo, useRef } from "react"
import type { Task } from "@tangerine/shared"
import { formatTaskTitle } from "../lib/format"
import { resolvePickerKey } from "../lib/picker-keyboard"
import { findTriggerToken } from "../lib/text-trigger"

export interface MentionPickerState {
  isOpen: boolean
  query: string
  selectedIndex: number
  /** Character index in textarea where the `#` trigger starts */
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
          formatTaskTitle(t).toLowerCase().includes(q) ||
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
    const token = findTriggerToken(text, cursorPos, "#")
    if (token) {
      setState({ isOpen: true, query: token.query, selectedIndex: 0, triggerStart: token.triggerStart })
      return
    }
    setState(CLOSED)
  }, [])

  const onKeyDown = useCallback((e: { key: string; preventDefault: () => void }): boolean => {
    if (!state.isOpen) return false
    const action = resolvePickerKey(e.key, state.selectedIndex, filteredCountRef.current)
    if (action.action === "none") return false
    e.preventDefault()
    if (action.action === "close") setState(CLOSED)
    else setState((s) => ({ ...s, selectedIndex: action.selectedIndex }))
    return true
  }, [state.isOpen, state.selectedIndex])

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
