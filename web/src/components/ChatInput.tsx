import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type ClipboardEvent, type MouseEvent } from "react"
import type { PromptImage, PredefinedPrompt, ProviderType, Task } from "@tangerine/shared"
import { ModelSelector } from "./ModelSelector"
import { ReasoningEffortSelector, type ReasoningEffort } from "./ReasoningEffortSelector"
import { MentionPicker } from "./MentionPicker"
import { SlashCommandPicker } from "./SlashCommandPicker"
import { useMentionPicker } from "../hooks/useMentionPicker"
import { useTasks } from "../hooks/useTasks"

interface PendingImage extends PromptImage {
  dataUrl: string // for thumbnail preview only
}

interface ChatInputProps {
  onSend: (text: string, images?: PromptImage[]) => void
  disabled: boolean
  queueLength: number
  taskId?: string
  isWorking?: boolean
  onAbort?: () => void
  model?: string | null
  provider?: ProviderType
  providerModels?: string[]
  reasoningEffort?: string | null
  onModelChange?: (model: string) => void
  onReasoningEffortChange?: (effort: string) => void
  predefinedPrompts?: PredefinedPrompt[]
  /** Raw message content to quote; shown as a chip above the input. Prepended as blockquote on send. */
  quotedMessage?: string | null
  onQuoteDismiss?: () => void
  /** Text currently selected in the message area; drives the Quote button visibility */
  selectedText?: string | null
  onQuoteSelection?: () => void
  /** When this value changes, the input is focused. Pass the task ID to focus on navigation. */
  autoFocusKey?: string
}

function loadChatDraft(key: string): { text?: string; pendingImages?: PendingImage[] } {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as { text?: string; pendingImages?: PendingImage[] }
  } catch {
    return {}
  }
}

export function appendQuotedText(existingText: string, quotedText: string): string {
  const prefix = existingText.trim().length > 0 ? `${existingText.replace(/\s+$/, "")}\n\n` : ""
  return `${prefix}${quotedText}\n\n`
}

export function ChatInput({ onSend, disabled, queueLength, taskId, isWorking, onAbort, model, provider, providerModels, reasoningEffort, onModelChange, onReasoningEffortChange, predefinedPrompts, quotedMessage, onQuoteDismiss, selectedText, onQuoteSelection, autoFocusKey }: ChatInputProps) {
  const draftKey = taskId ? `tangerine:chat-draft:${taskId}` : null

  const [text, setText] = useState(() => draftKey ? (loadChatDraft(draftKey).text ?? "") : "")
  const [pendingImages, setPendingImages] = useState<PendingImage[]>(() => draftKey ? (loadChatDraft(draftKey).pendingImages ?? []) : [])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { tasks: allTasks } = useTasks()
  const mention = useMentionPicker(allTasks)
  const mentionRef = useRef(mention)
  mentionRef.current = mention
  const textRef = useRef(text)
  textRef.current = text

  // Slash command (skill) picker state
  const [skills, setSkills] = useState<string[]>([])
  const [slashState, setSlashState] = useState<{ isOpen: boolean; query: string; selectedIndex: number; triggerStart: number }>({
    isOpen: false, query: "", selectedIndex: 0, triggerStart: -1,
  })
  const slashStateRef = useRef(slashState)
  slashStateRef.current = slashState
  const skillsRef = useRef(skills)
  skillsRef.current = skills

  // Fetch skills when the task is known
  useEffect(() => {
    if (!taskId) return
    fetch(`/api/tasks/${taskId}/skills`)
      .then((r) => r.ok ? r.json() as Promise<{ skills: string[] }> : Promise.resolve({ skills: [] }))
      .then((data) => setSkills(data.skills))
      .catch(() => {})
  }, [taskId])

  // Ref to latest draft state — used in the unmount cleanup to avoid stale closures
  const draftStateRef = useRef({ text, pendingImages })
  useEffect(() => { draftStateRef.current = { text, pendingImages } }, [text, pendingImages])

  // Save draft on unmount so switching tasks (via key={taskId}) doesn't lose in-progress text
  useEffect(() => {
    return () => {
      if (!draftKey) return
      const { text: t, pendingImages: imgs } = draftStateRef.current
      try {
        if (!t && imgs.length === 0) {
          localStorage.removeItem(draftKey)
        } else {
          localStorage.setItem(draftKey, JSON.stringify({ text: t, pendingImages: imgs }))
        }
      } catch { /* ignore */ }
    }
  }, [draftKey])

  const filteredSkills = slashState.isOpen
    ? skills.filter((s) => s.toLowerCase().includes(slashState.query.toLowerCase())).slice(0, 8)
    : []

  const closeSlash = useCallback(() => {
    setSlashState({ isOpen: false, query: "", selectedIndex: 0, triggerStart: -1 })
  }, [])

  const selectSkill = useCallback((skill: string) => {
    const { triggerStart, query } = slashStateRef.current
    const currentText = textRef.current
    const before = currentText.slice(0, triggerStart)
    const after = currentText.slice(triggerStart + 1 + query.length)
    const newText = `${before}/${skill} ${after}`
    setText(newText)
    setSlashState({ isOpen: false, query: "", selectedIndex: 0, triggerStart: -1 })
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      const pos = before.length + skill.length + 2 // "/<skill> "
      textarea.setSelectionRange(pos, pos)
      textarea.focus()
    })
  }, [])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if ((!trimmed && pendingImages.length === 0 && !quotedMessage) || disabled) return
    const images = pendingImages.length > 0
      ? pendingImages.map(({ dataUrl: _dataUrl, ...img }) => img)
      : undefined
    let finalText = trimmed
    if (quotedMessage) {
      const quotedLines = quotedMessage.split("\n").map((line) => `> ${line}`).join("\n")
      finalText = trimmed ? `${quotedLines}\n\n${trimmed}` : quotedLines
    }
    onSend(finalText, images)
    setText("")
    setPendingImages([])
    onQuoteDismiss?.()
    if (draftKey) {
      try { localStorage.removeItem(draftKey) } catch { /* ignore */ }
    }
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [text, pendingImages, disabled, onSend, draftKey, quotedMessage, onQuoteDismiss])

  const handleMentionSelect = useCallback((task: Task) => {
    const { newText, cursorPos } = mentionRef.current.selectTask(task, textRef.current)
    setText(newText)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.setSelectionRange(cursorPos, cursorPos)
      textarea.focus()
    })
  }, [])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const m = mentionRef.current
      // Let mention picker consume keys first
      if (m.state.isOpen) {
        const selectedTask = m.filteredTasks[m.state.selectedIndex]
        if ((e.key === "Enter" || e.key === "Tab") && selectedTask) {
          e.preventDefault()
          handleMentionSelect(selectedTask)
          return
        }
        if (m.onKeyDown(e)) return
      }
      // Slash command picker keys
      const slash = slashStateRef.current
      if (slash.isOpen) {
        if (e.key === "Escape") {
          e.preventDefault()
          closeSlash()
          return
        }
        if (e.key === "ArrowDown") {
          e.preventDefault()
          setSlashState((s) => ({ ...s, selectedIndex: Math.min(s.selectedIndex + 1, skillsRef.current.filter((sk) => sk.toLowerCase().includes(s.query.toLowerCase())).slice(0, 8).length - 1) }))
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          setSlashState((s) => ({ ...s, selectedIndex: Math.max(s.selectedIndex - 1, 0) }))
          return
        }
        if (e.key === "Enter" || e.key === "Tab") {
          const filtered = skillsRef.current.filter((sk) => sk.toLowerCase().includes(slash.query.toLowerCase())).slice(0, 8)
          const skill = filtered[slash.selectedIndex]
          if (skill) {
            e.preventDefault()
            selectSkill(skill)
            return
          }
        }
      }
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend, handleMentionSelect, closeSlash, selectSkill],
  )

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`
  }, [])

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          const commaIdx = dataUrl.indexOf(",")
          const meta = dataUrl.slice(5, commaIdx) // strip "data:"
          const mediaType = meta.split(";")[0] as PromptImage["mediaType"]
          const data = dataUrl.slice(commaIdx + 1)
          setPendingImages((prev) => [...prev, { dataUrl, mediaType, data }])
        }
        reader.readAsDataURL(file)
      }
    }
  }, [])

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index))
  }, [])


  const [isFocused, setIsFocused] = useState(false)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    if (!isFocused) {
      textarea.style.height = "auto"
      return
    }
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`
  }, [text, isFocused])

  useEffect(() => {
    if (autoFocusKey === undefined) return
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }, [autoFocusKey])

  // Focus textarea when a quote is set so user can type reply immediately
  useEffect(() => {
    if (!quotedMessage) return
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }, [quotedMessage])


  // Continuously save draft while editing
  useEffect(() => {
    if (!draftKey) return
    try {
      if (!text && pendingImages.length === 0) {
        localStorage.removeItem(draftKey)
      } else {
        localStorage.setItem(draftKey, JSON.stringify({ text, pendingImages }))
      }
    } catch {
      // ignore storage failures
    }
  }, [draftKey, text, pendingImages])

  const handlePromptClick = useCallback((e: MouseEvent, promptText: string) => {
    e.preventDefault()
    onSend(promptText)
    // Only blur on mobile to dismiss the virtual keyboard; desktop doesn't need it
    if ('ontouchstart' in window) {
      textareaRef.current?.blur()
    }
  }, [onSend])

  // Chips are visible whenever the input is focused and empty — same on all breakpoints
  const showPrompts = isFocused && !text.trim() && !!predefinedPrompts?.length

  const canSend = (text.trim().length > 0 || pendingImages.length > 0 || !!quotedMessage) && !disabled
  const canChangeModel = providerModels && providerModels.length > 1 && onModelChange

  return (
    <div className="relative border-t border-edge bg-surface px-3 py-2 md:bg-surface md:p-3 md:px-4">
      {/* Predefined prompt chips + Quote button — absolutely positioned to avoid layout shift */}
      {(showPrompts || selectedText) && (
        <div className="pointer-events-none absolute bottom-full left-0 right-0 px-3 pb-2 md:px-4">
          <div className="pointer-events-auto flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {selectedText && onQuoteSelection && (
              <button
                onMouseDown={(e) => { e.preventDefault(); onQuoteSelection() }}
                className="pointer-events-auto shrink-0 flex items-center gap-1.5 rounded-md border border-tangerine/30 bg-tangerine/10 px-3 py-1 text-xs font-medium text-tangerine shadow-sm transition hover:bg-tangerine/20"
              >
                <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.293-3.995 5.848h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.293-3.996 5.848h3.983v10h-9.983z" />
                </svg>
                Quote
              </button>
            )}
            {showPrompts && predefinedPrompts && predefinedPrompts.map((prompt, i) => (
              <button
                key={i}
                onMouseDown={(e) => handlePromptClick(e, prompt.text)}
                className="pointer-events-auto shrink-0 rounded-full border border-edge bg-surface-secondary px-3 py-1 text-xs text-fg-muted shadow-sm transition hover:bg-surface-dark hover:text-white"
              >
                {prompt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quote chip — shown when replying to a message */}
      {quotedMessage && (
        <div className="mb-2 flex items-center gap-2 self-start rounded-full border border-tangerine/25 bg-tangerine/10 pl-2.5 pr-1.5 py-1 text-xs max-w-xs">
          <svg className="h-3 w-3 shrink-0 text-tangerine/70" fill="currentColor" viewBox="0 0 24 24">
            <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.293-3.995 5.848h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.293-3.996 5.848h3.983v10h-9.983z" />
          </svg>
          <span className="truncate text-fg-muted">
            {quotedMessage.length > 60 ? `${quotedMessage.slice(0, 60)}…` : quotedMessage}
          </span>
          <button
            onClick={onQuoteDismiss}
            aria-label="Dismiss quote"
            className="shrink-0 rounded-full p-0.5 text-fg-muted transition hover:bg-tangerine/10 hover:text-fg"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Pasted image thumbnails */}
      {pendingImages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pendingImages.map((img, i) => (
            <div key={i} className="relative">
              <img
                src={img.dataUrl}
                alt="Pasted image"
                className="h-14 w-14 rounded-md border border-edge object-cover"
              />
              <button
                onClick={() => removeImage(i)}
                aria-label="Remove image"
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-fg text-2xs text-white"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="relative min-w-0 flex-1">
          {mention.state.isOpen && (
            <MentionPicker
              tasks={mention.filteredTasks}
              selectedIndex={mention.state.selectedIndex}
              onSelect={handleMentionSelect}
              onHover={(i) => mention.setSelectedIndex(i)}
            />
          )}
          {slashState.isOpen && filteredSkills.length > 0 && (
            <SlashCommandPicker
              skills={filteredSkills}
              selectedIndex={slashState.selectedIndex}
              onSelect={selectSkill}
              onHover={(i) => setSlashState((s) => ({ ...s, selectedIndex: i }))}
            />
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              const val = e.target.value
              const cursor = e.target.selectionStart ?? val.length
              setText(val)
              handleInput()
              mention.onTextChange(val, cursor)
              // Detect slash trigger: `/` at start of text or after whitespace
              let si = cursor - 1
              while (si >= 0) {
                const ch = val[si]
                if (ch === "/") {
                  if (si === 0 || val[si - 1] === " " || val[si - 1] === "\n") {
                    const query = val.slice(si + 1, cursor)
                    if (!query.includes(" ") && !query.includes("\n") && skillsRef.current.length > 0) {
                      setSlashState({ isOpen: true, query, selectedIndex: 0, triggerStart: si })
                    } else {
                      closeSlash()
                    }
                    break
                  }
                  break
                }
                if (ch === " " || ch === "\n") { closeSlash(); break }
                si--
              }
              if (si < 0) closeSlash()
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => {
              setIsFocused(true)
              handleInput()
            }}
            onBlur={() => {
              setIsFocused(false)
              mention.close()
              closeSlash()
              if (textareaRef.current) {
                textareaRef.current.style.height = "auto"
              }
            }}
            placeholder={isWorking ? "Agent is working... (messages will be queued)" : "Message agent..."}
            disabled={disabled}
            rows={1}
            className="min-h-9 w-full resize-none rounded-lg border border-edge bg-surface px-3 py-2 text-base text-fg placeholder-fg-faint outline-none transition focus:border-fg-faint disabled:cursor-not-allowed disabled:opacity-50 md:px-3.5 md:text-md md:placeholder-fg-muted"
          />
          {queueLength > 0 && (
            <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-tangerine text-2xs font-bold text-white">
              {queueLength}
            </span>
          )}
        </div>

        {/* Send button — always visible on all breakpoints */}
        <button
          onClick={handleSend}
          disabled={!canSend}
          aria-label="Send message"
          className="mb-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-dark text-white transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-30 md:rounded-lg"
        >
          <svg className="h-4 w-4 md:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
          </svg>
          <svg className="hidden h-4 w-4 md:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
          </svg>
        </button>
      </div>

      {/* Model + reasoning selectors + stop button */}
      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {canChangeModel ? (
            <ModelSelector
              models={providerModels}
              model={model ?? providerModels[0] ?? ""}
              onModelChange={onModelChange}
            />
          ) : model ? (
            <ModelSelector model={model} models={[model]} />
          ) : null}
          {onReasoningEffortChange && (
            <ReasoningEffortSelector
              value={(reasoningEffort as ReasoningEffort) ?? "medium"}
              onChange={onReasoningEffortChange}
              provider={provider}
            />
          )}
        </div>
        {isWorking && (
          <button
            onClick={onAbort}
            className="flex items-center gap-1 rounded bg-status-error px-2 py-1"
          >
            <svg className="h-2.5 w-2.5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
            <span className="text-xxs font-medium text-white">Stop agent</span>
          </button>
        )}
      </div>
    </div>
  )
}
