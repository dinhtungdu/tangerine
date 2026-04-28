import { useCallback, useMemo, useRef, useState } from "react"
import type { AgentSlashCommand } from "@tangerine/shared"
import { resolvePickerKey } from "../lib/picker-keyboard"
import { findTriggerToken } from "../lib/text-trigger"

export interface SlashCommandPickerState {
  isOpen: boolean
  query: string
  selectedIndex: number
  triggerStart: number
}

export interface UseSlashCommandPickerResult {
  state: SlashCommandPickerState
  filteredCommands: AgentSlashCommand[]
  onTextChange: (text: string, cursorPos: number) => void
  onKeyDown: (e: { key: string; preventDefault: () => void }) => boolean
  selectCommand: (command: AgentSlashCommand, text: string) => { newText: string; cursorPos: number }
  close: () => void
  setSelectedIndex: (index: number) => void
}

const CLOSED: SlashCommandPickerState = { isOpen: false, query: "", selectedIndex: 0, triggerStart: -1 }

export function useSlashCommandPicker(commands: AgentSlashCommand[]): UseSlashCommandPickerResult {
  const [state, setState] = useState<SlashCommandPickerState>(CLOSED)
  const filteredCountRef = useRef(0)

  const filteredCommands = useMemo(() => {
    if (!state.isOpen) return []
    const q = state.query.toLowerCase()
    return commands
      .filter((command) => command.name.toLowerCase().includes(q) || command.description.toLowerCase().includes(q))
      .slice(0, 8)
  }, [commands, state.isOpen, state.query])

  filteredCountRef.current = filteredCommands.length

  const close = useCallback(() => setState(CLOSED), [])

  const onTextChange = useCallback((text: string, cursorPos: number) => {
    const token = findTriggerToken(text, cursorPos, "/", "line-start")
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

  const selectCommand = useCallback((command: AgentSlashCommand, text: string): { newText: string; cursorPos: number } => {
    const beforeCommand = text.slice(0, state.triggerStart)
    const afterQuery = text.slice(state.triggerStart + 1 + state.query.length)
    const replacement = `/${command.name} `
    const newText = `${beforeCommand}${replacement}${afterQuery}`
    const cursorPos = beforeCommand.length + replacement.length
    setState(CLOSED)
    return { newText, cursorPos }
  }, [state.query.length, state.triggerStart])

  const setSelectedIndex = useCallback((index: number) => {
    setState((s) => ({ ...s, selectedIndex: index }))
  }, [])

  return { state, filteredCommands, onTextChange, onKeyDown, selectCommand, close, setSelectedIndex }
}
