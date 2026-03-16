import { useState, useRef, useCallback, type KeyboardEvent } from "react"
import { ModelSelector } from "./ModelSelector"

interface ChatInputProps {
  onSend: (text: string) => void
  disabled: boolean
  queueLength: number
  isWorking?: boolean
  onAbort?: () => void
}

export function ChatInput({ onSend, disabled, queueLength, isWorking, onAbort }: ChatInputProps) {
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

  return (
    <div className="border-t border-[#e5e5e5] bg-[#fafafa] p-3 px-4">
      <div className="flex items-end gap-2">
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              handleInput()
            }}
            onKeyDown={handleKeyDown}
            placeholder={disabled ? "Agent is working..." : "Send a message or give instructions..."}
            disabled={disabled}
            rows={1}
            className="w-full resize-none rounded-lg border border-[#e5e5e5] bg-[#fafafa] px-3.5 py-2.5 text-[13px] text-[#0a0a0a] placeholder-[#737373] outline-none transition focus:border-[#a3a3a3] disabled:cursor-not-allowed disabled:opacity-50"
          />
          {queueLength > 0 && (
            <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-tangerine text-[10px] font-bold text-white">
              {queueLength}
            </span>
          )}
        </div>
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#171717] text-[#fafafa] transition hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-30"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
          </svg>
        </button>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <ModelSelector />
        {isWorking && (
          <button
            onClick={onAbort}
            className="flex items-center gap-1 rounded bg-[#e7000b] px-2 py-1"
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
