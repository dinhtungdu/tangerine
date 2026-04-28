import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { buildAuthHeaders } from "../lib/auth"
import { resolvePickerKey } from "../lib/picker-keyboard"
import { findTriggerToken } from "../lib/text-trigger"

export interface FileMention {
  path: string
}

export interface FileMentionPickerState {
  isOpen: boolean
  query: string
  selectedIndex: number
  triggerStart: number
}

export interface UseFileMentionPickerResult {
  state: FileMentionPickerState
  filteredFiles: FileMention[]
  onTextChange: (text: string, cursorPos: number) => void
  onKeyDown: (e: { key: string; preventDefault: () => void }) => boolean
  selectFile: (file: FileMention, text: string) => { newText: string; cursorPos: number }
  close: () => void
  setSelectedIndex: (index: number) => void
}

const CLOSED: FileMentionPickerState = { isOpen: false, query: "", selectedIndex: 0, triggerStart: -1 }

function endpointFor(params: { taskId?: string; projectId?: string }): string | null {
  if (params.taskId) return `/api/tasks/${encodeURIComponent(params.taskId)}/files`
  if (params.projectId) return `/api/projects/${encodeURIComponent(params.projectId)}/files`
  return null
}

export function useFileMentionPicker(params: { taskId?: string; projectId?: string }): UseFileMentionPickerResult {
  const [state, setState] = useState<FileMentionPickerState>(CLOSED)
  const [files, setFiles] = useState<FileMention[]>([])
  const filteredCountRef = useRef(0)
  const endpoint = useMemo(() => endpointFor(params), [params.taskId, params.projectId])

  useEffect(() => {
    if (!state.isOpen || !endpoint) {
      setFiles([])
      return
    }
    const controller = new AbortController()
    const query = encodeURIComponent(state.query)
    fetch(`${endpoint}?query=${query}`, { headers: buildAuthHeaders(), signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ files?: FileMention[] }> : Promise.resolve({ files: [] }))
      .then((data) => setFiles(data.files?.slice(0, 8) ?? []))
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setFiles([])
      })
    return () => controller.abort()
  }, [endpoint, state.isOpen, state.query])

  filteredCountRef.current = files.length

  const close = useCallback(() => {
    setState(CLOSED)
    setFiles([])
  }, [])

  const onTextChange = useCallback((text: string, cursorPos: number) => {
    const token = findTriggerToken(text, cursorPos, "@")
    if (token) {
      setState({ isOpen: true, query: token.query, selectedIndex: 0, triggerStart: token.triggerStart })
      return
    }
    setState(CLOSED)
    setFiles([])
  }, [])

  const onKeyDown = useCallback((e: { key: string; preventDefault: () => void }): boolean => {
    if (!state.isOpen) return false
    const action = resolvePickerKey(e.key, state.selectedIndex, filteredCountRef.current)
    if (action.action === "none") return false
    e.preventDefault()
    if (action.action === "close") close()
    else setState((s) => ({ ...s, selectedIndex: action.selectedIndex }))
    return true
  }, [close, state.isOpen, state.selectedIndex])

  const selectFile = useCallback((file: FileMention, text: string): { newText: string; cursorPos: number } => {
    const beforeMention = text.slice(0, state.triggerStart)
    const afterQuery = text.slice(state.triggerStart + 1 + state.query.length)
    const replacement = `@${file.path} `
    const newText = `${beforeMention}${replacement}${afterQuery}`
    const cursorPos = beforeMention.length + replacement.length
    close()
    return { newText, cursorPos }
  }, [close, state.query.length, state.triggerStart])

  const setSelectedIndex = useCallback((index: number) => {
    setState((s) => ({ ...s, selectedIndex: index }))
  }, [])

  return { state, filteredFiles: files, onTextChange, onKeyDown, selectFile, close, setSelectedIndex }
}
