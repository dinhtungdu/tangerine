import React, { useState, useRef, useCallback, useEffect, type KeyboardEvent, type ClipboardEvent, type MouseEvent } from "react"
import { ArrowUp, X, Quote, Paperclip } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { PromptImage, PredefinedPrompt, ProviderType, Task } from "@tangerine/shared"
import { ModelEffortPopover } from "./ModelEffortPopover"
import { MentionPicker } from "./MentionPicker"
import { SlashCommandPicker } from "./SlashCommandPicker"
import { useMentionPicker } from "../hooks/useMentionPicker"
import { useTasks } from "../hooks/useTasks"
import { formatTokens } from "../lib/format"
import { buildAuthHeaders } from "../lib/auth"

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
  /** Actual current context window usage (only available for Claude Code via message_start) */
  contextTokens?: number
  /** Max context window size in tokens for the current model */
  contextWindowMax?: number
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

export function ChatInput({ onSend, disabled, queueLength, taskId, isWorking, onAbort, model, provider, providerModels, reasoningEffort, onModelChange, onReasoningEffortChange, predefinedPrompts, quotedMessage, onQuoteDismiss, selectedText, onQuoteSelection, autoFocusKey, contextTokens, contextWindowMax }: ChatInputProps) {
  const draftKey = taskId ? `tangerine:chat-draft:${taskId}` : null

  const [text, setText] = useState(() => draftKey ? (loadChatDraft(draftKey).text ?? "") : "")
  const [pendingImages, setPendingImages] = useState<PendingImage[]>(() => draftKey ? (loadChatDraft(draftKey).pendingImages ?? []) : [])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  // Fetch skills on mount and whenever the agent finishes a turn (isWorking → false),
  // because Claude/Pi populate skills asynchronously from the init/state event.
  useEffect(() => {
    if (!taskId || isWorking) return
    fetch(`/api/tasks/${taskId}/skills`, { headers: buildAuthHeaders() })
      .then((r) => r.ok ? r.json() as Promise<{ skills: string[] }> : Promise.resolve({ skills: [] }))
      .then((data) => { if (data.skills.length > 0) setSkills(data.skills) })
      .catch(() => {})
  }, [taskId, isWorking])

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
    if (textareaRef.current) textareaRef.current.style.height = "auto"
    if (draftKey) {
      try { localStorage.removeItem(draftKey) } catch { /* ignore */ }
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
        const filtered = skillsRef.current.filter((sk) => sk.toLowerCase().includes(slash.query.toLowerCase())).slice(0, 8)
        // Only intercept navigation/selection keys when the picker is actually visible
        if (filtered.length > 0) {
          if (e.key === "Escape") {
            e.preventDefault()
            closeSlash()
            return
          }
          if (e.key === "ArrowDown") {
            e.preventDefault()
            setSlashState((s) => ({ ...s, selectedIndex: Math.min(s.selectedIndex + 1, filtered.length - 1) }))
            return
          }
          if (e.key === "ArrowUp") {
            e.preventDefault()
            setSlashState((s) => ({ ...s, selectedIndex: Math.max(s.selectedIndex - 1, 0) }))
            return
          }
          if (e.key === "Enter" || e.key === "Tab") {
            const skill = filtered[slash.selectedIndex]
            if (skill) {
              e.preventDefault()
              selectSkill(skill)
              return
            }
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

  // JS fallback for browsers without field-sizing:content support (Chrome <123, Firefox <130, Safari <18)
  const handleResize = useCallback(() => {
    if (typeof CSS !== "undefined" && CSS.supports("field-sizing", "content")) return
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

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          const commaIdx = dataUrl.indexOf(",")
          const meta = dataUrl.slice(5, commaIdx)
          const mediaType = meta.split(";")[0] as PromptImage["mediaType"]
          const data = dataUrl.slice(commaIdx + 1)
          setPendingImages((prev) => [...prev, { dataUrl, mediaType, data }])
        }
        reader.readAsDataURL(file)
      }
    }
    // Reset input so same file can be selected again
    e.target.value = ""
  }, [])

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

  // Chips are visible whenever the input is empty — hide once user starts typing
  const showPrompts = !text.trim() && !!predefinedPrompts?.length

  const canSend = (text.trim().length > 0 || pendingImages.length > 0 || !!quotedMessage) && !disabled
  const canChangeModel = providerModels && providerModels.length > 1 && onModelChange
  // Show "used/max" when both available, just "used" when only contextTokens
  const hasContext = contextTokens && contextTokens > 0
  const contextWindowLabel = hasContext
    ? contextWindowMax
      ? `${formatTokens(contextTokens)}/${formatTokens(contextWindowMax)}`
      : formatTokens(contextTokens)
    : null
  const contextWindowTitle = hasContext
    ? contextWindowMax
      ? `${contextTokens!.toLocaleString()} / ${contextWindowMax!.toLocaleString()} tokens`
      : `${contextTokens!.toLocaleString()} tokens`
    : undefined

  return (
    <div className="relative border-t border-border bg-background px-3 py-2 md:bg-background md:p-3 md:px-4">
      {/* Predefined prompt chips + Quote button — absolutely positioned to avoid layout shift */}
      {(showPrompts || selectedText) && (
        <div className="pointer-events-none absolute bottom-full left-0 right-0 px-3 pb-2 md:px-4">
          <div className="pointer-events-auto flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {selectedText && onQuoteSelection && (
              <Button
                variant="outline"
                size="xs"
                onMouseDown={(e) => { e.preventDefault(); onQuoteSelection() }}
                className="pointer-events-auto shrink-0 border-orange-200 bg-orange-100 text-orange-600 shadow-sm hover:bg-orange-200 dark:border-orange-800 dark:bg-orange-900 dark:text-orange-400 dark:hover:bg-orange-800"
              >
                <Quote className="h-3 w-3" />
                Quote
              </Button>
            )}
            {showPrompts && predefinedPrompts && predefinedPrompts.map((prompt, i) => (
              <Button
                key={i}
                variant="secondary"
                size="xs"
                onMouseDown={(e) => handlePromptClick(e, prompt.text)}
                className="pointer-events-auto shrink-0 rounded-full"
              >
                {prompt.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Quote chip — shown when replying to a message */}
      {quotedMessage && (
        <div className="mb-2 flex items-center gap-2 self-start rounded-full border border-orange-500/25 bg-orange-500/10 pl-2.5 pr-1.5 py-1 text-xs max-w-xs">
          <Quote className="h-3 w-3 shrink-0 text-orange-500/70" />
          <span className="truncate text-muted-foreground">
            {quotedMessage.length > 60 ? `${quotedMessage.slice(0, 60)}…` : quotedMessage}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onQuoteDismiss}
            aria-label="Dismiss quote"
            className="shrink-0 rounded-full text-muted-foreground hover:bg-orange-500/10 hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </Button>
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
                className="h-14 w-14 rounded-md border border-border object-cover"
              />
              <button
                onClick={() => removeImage(i)}
                aria-label="Remove image"
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-2xs text-white outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main input group with integrated toolbar */}
      <div className="relative">
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
        <div className="rounded-lg border border-input bg-background transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50 dark:bg-input/30">
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              const val = e.target.value
              const cursor = e.target.selectionStart ?? val.length
              setText(val)
              handleResize()
              mention.onTextChange(val, cursor)
              // Detect slash trigger: `/` at start of text or after whitespace
              let si = cursor - 1
              while (si >= 0) {
                const ch = val[si]
                if (ch === "/") {
                  if (si === 0 || val[si - 1] === " " || val[si - 1] === "\n") {
                    const query = val.slice(si + 1, cursor)
                    if (!query.includes(" ") && !query.includes("\n")) {
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
            onBlur={() => {
              mention.close()
              closeSlash()
            }}
            placeholder={isWorking ? "Agent is working... (messages will be queued)" : "Message agent..."}
            disabled={disabled}
            rows={1}
            className="min-h-9 max-h-36 resize-none rounded-none border-0 bg-transparent px-3 shadow-none ring-0 focus-visible:border-transparent focus-visible:ring-0 placeholder:text-muted-foreground/50 md:px-3.5"
          />
          {/* Bottom toolbar: model/effort on left, queue badge + send on right */}
          <div
            className="flex w-full items-center justify-between px-2.5 pb-2 pt-2"
            onClick={(e: React.MouseEvent) => {
              if ((e.target as HTMLElement).closest("button")) return
              textareaRef.current?.focus()
            }}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileSelect}
                className="hidden"
              />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach file"
                className="text-muted-foreground hover:text-foreground"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              {(canChangeModel || model || onReasoningEffortChange) && (
                <ModelEffortPopover
                  models={providerModels ?? (model ? [model] : [])}
                  model={model ?? providerModels?.[0] ?? ""}
                  onModelChange={onModelChange ?? (() => {})}
                  canChangeModel={!!canChangeModel}
                  reasoningEffort={reasoningEffort}
                  onReasoningEffortChange={onReasoningEffortChange}
                  provider={provider}
                />
              )}
              {contextWindowLabel && (
                <span className="font-mono text-2xs text-muted-foreground/60" title={contextWindowTitle}>
                  {contextWindowLabel}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {queueLength > 0 && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-orange-500 text-2xs font-bold text-white">
                  {queueLength}
                </span>
              )}
              {isWorking && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onAbort}
                  aria-label="Stop agent"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                </Button>
              )}
              <Button
                onClick={handleSend}
                disabled={!canSend}
                aria-label="Send message"
                size="icon-sm"
                className="shrink-0"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
