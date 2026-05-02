import { useState, useRef as useReactRef } from "react"
import type { TerminalHandle } from "@wterm/react"
import { Button } from "@/components/ui/button"

interface TerminalToolbarProps {
  termRef: React.RefObject<TerminalHandle | null>
  onInput: (data: string) => void
}

interface KeyDef {
  label: string
  /** The escape sequence or character(s) to send */
  input: string | (() => Promise<void>)
  /** aria-label override */
  ariaLabel?: string
  /** Extra CSS classes */
  className?: string
}

// Control character helper
const ctrl = (ch: string) => String.fromCharCode(ch.charCodeAt(0) - 64)

/** Read clipboard text, falling back to a visible textarea for HTTP contexts */
async function readClipboard(): Promise<string | null> {
  // Try the Clipboard API first (works over HTTPS / localhost)
  if (navigator.clipboard && window.isSecureContext) {
    try {
      const text = await navigator.clipboard.readText()
      if (text) return text
    } catch {
      // Permission denied — fall through
    }
  }
  // No fallback available programmatically over HTTP — return null
  // to signal caller should show the paste modal
  return null
}

export function TerminalToolbar({ termRef, onInput }: TerminalToolbarProps) {
  const [showPasteInput, setShowPasteInput] = useState(false)
  const pasteRef = useReactRef<HTMLTextAreaElement>(null)
  const shouldRestoreFocusRef = useReactRef(false)

  function focusTerminal() {
    const handle = termRef.current
    if (!handle) return
    handle.focus()
    const inst = handle.instance as Record<string, unknown> | null
    const el = inst?.element as HTMLElement | undefined
    if (el) {
      const maxScroll = el.scrollHeight - el.clientHeight
      if (maxScroll > 0) el.scrollTop = maxScroll
    }
  }

  const ctrlKeys: KeyDef[] = [
    { label: "⌃C", input: ctrl("C"), ariaLabel: "Send Ctrl+C (interrupt)" },
    { label: "⌃D", input: ctrl("D"), ariaLabel: "Send Ctrl+D (EOF)" },
    { label: "⎋", input: "\x1b", ariaLabel: "Send Escape" },
  ]

  const tabKeys: KeyDef[] = [
    { label: "⇥", input: "\t", ariaLabel: "Send Tab (autocomplete)" },
    { label: "⇤", input: "\x1b[Z", ariaLabel: "Send Shift+Tab" },
  ]

  const arrowKeys: KeyDef[] = [
    { label: "←", input: "\x1b[D", ariaLabel: "Arrow Left" },
    { label: "↓", input: "\x1b[B", ariaLabel: "Arrow Down" },
    { label: "↑", input: "\x1b[A", ariaLabel: "Arrow Up" },
    { label: "→", input: "\x1b[C", ariaLabel: "Arrow Right" },
  ]

  const pasteKey: KeyDef = {
    label: "⎗",
    ariaLabel: "Paste from clipboard",
    input: async () => {
      shouldRestoreFocusRef.current = true
      try {
        const text = await readClipboard()
        if (text) {
          onInput(text)
        } else {
          setShowPasteInput(true)
          shouldRestoreFocusRef.current = false
          requestAnimationFrame(() => pasteRef.current?.focus())
          return
        }
      } finally {
        if (shouldRestoreFocusRef.current) {
          focusTerminal()
          shouldRestoreFocusRef.current = false
        }
      }
    },
  }

  function handlePress(key: KeyDef) {
    if (typeof key.input === "function") {
      key.input()
    } else {
      onInput(key.input)
      focusTerminal()
    }
  }

  function submitPaste() {
    const text = pasteRef.current?.value
    if (text) onInput(text)
    setShowPasteInput(false)
    focusTerminal()
  }

  const renderKey = (key: KeyDef) => (
    <Button
      key={key.label}
      variant="ghost"
      size="sm"
      onTouchStart={(e: React.TouchEvent) => {
        e.preventDefault()
        handlePress(key)
      }}
      onMouseDown={(e: React.MouseEvent) => {
        e.preventDefault()
        handlePress(key)
      }}
      aria-label={key.ariaLabel ?? key.label}
      className="h-8 min-w-8 shrink-0 rounded-full px-2.5 text-base text-muted-foreground/80 hover:bg-white/10 hover:text-foreground active:bg-white/20"
    >
      {key.label}
    </Button>
  )

  return (
    <div className="md:hidden">
      <div className="flex items-center gap-1 overflow-x-auto px-2 py-1.5">
        <div className="flex gap-0.5">
          {ctrlKeys.map(renderKey)}
        </div>
        <div className="mx-1 h-4 w-px bg-white/10" />
        <div className="flex gap-0.5">
          {tabKeys.map(renderKey)}
        </div>
        <div className="mx-1 h-4 w-px bg-white/10" />
        <div className="flex gap-0.5">
          {arrowKeys.map(renderKey)}
        </div>
        <div className="mx-1 h-4 w-px bg-white/10" />
        {renderKey(pasteKey)}
      </div>
      {showPasteInput && (
        <div className="flex items-center gap-2 px-2 py-1.5">
          <textarea
            ref={pasteRef}
            rows={1}
            placeholder="Paste here, then tap Send"
            className="min-h-[36px] flex-1 resize-none rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-white/20"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                submitPaste()
              }
            }}
          />
          <Button
            size="sm"
            onClick={submitPaste}
            className="h-8 shrink-0 rounded-full px-3"
          >
            Send
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowPasteInput(false)
              focusTerminal()
            }}
            aria-label="Cancel paste"
            className="h-8 min-w-8 shrink-0 rounded-full text-muted-foreground/80 hover:bg-white/10"
          >
            ✕
          </Button>
        </div>
      )}
    </div>
  )
}
