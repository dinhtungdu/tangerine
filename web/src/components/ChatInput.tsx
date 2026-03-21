import { useState, useRef, useCallback, type KeyboardEvent } from "react"
import { ModelSelector } from "./ModelSelector"
import { ReasoningEffortSelector, type ReasoningEffort } from "./ReasoningEffortSelector"

interface ChatInputProps {
  onSend: (text: string) => void
  disabled: boolean
  queueLength: number
  isWorking?: boolean
  onAbort?: () => void
  model?: string | null
  providerModels?: string[]
  reasoningEffort?: string | null
  onModelChange?: (model: string) => void
  onReasoningEffortChange?: (effort: string) => void
}

export function ChatInput({ onSend, disabled, queueLength, isWorking, onAbort, model, providerModels, reasoningEffort, onModelChange, onReasoningEffortChange }: ChatInputProps) {
  const [text, setText] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText("")
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [text, disabled, onSend])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`
  }, [])

  const canChangeModel = providerModels && providerModels.length > 1 && onModelChange

  return (
    <div className="border-t border-edge bg-surface px-3 py-2 md:bg-surface md:p-3 md:px-4">
      <div className="flex items-start gap-2">
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              handleInput()
            }}
            onKeyDown={handleKeyDown}
            placeholder={disabled ? "Agent is working..." : "Message agent..."}
            disabled={disabled}
            rows={1}
            className="min-h-9 w-full resize-none rounded-lg border border-edge bg-surface px-3 py-2 text-[16px] text-fg placeholder-fg-faint outline-none transition focus:border-fg-faint disabled:cursor-not-allowed disabled:opacity-50 md:px-3.5 md:text-[13px] md:placeholder-fg-muted"
          />
          {queueLength > 0 && (
            <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-tangerine text-[10px] font-bold text-white">
              {queueLength}
            </span>
          )}
        </div>

        {/* Mobile: circle send/stop button */}
        <div className="md:hidden">
          {isWorking ? (
            <button onClick={onAbort} aria-label="Stop agent" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-status-error text-white">
              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
            </button>
          ) : (
            <button onClick={handleSend} disabled={disabled || !text.trim()} aria-label="Send message" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-dark text-white disabled:opacity-30">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
              </svg>
            </button>
          )}
        </div>

        {/* Desktop: square send button */}
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          aria-label="Send message"
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-dark text-surface transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-30 md:flex"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
            />
          )}
        </div>
        {isWorking && (
          <button
            onClick={onAbort}
            className="hidden items-center gap-1 rounded bg-status-error px-2 py-1 md:flex"
          >
            <svg className="h-2.5 w-2.5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
            <span className="text-[11px] font-medium text-white">Stop agent</span>
          </button>
        )}
      </div>
    </div>
  )
}
