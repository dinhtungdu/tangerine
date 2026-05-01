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

  const keys: KeyDef[] = [
    { label: "^C", input: ctrl("C"), ariaLabel: "Send Ctrl+C (interrupt)" },
    { label: "Tab", input: "\t", ariaLabel: "Send Tab (autocomplete)" },
    { label: "↑", input: "\x1b[A", ariaLabel: "Arrow Up" },
    { label: "↓", input: "\x1b[B", ariaLabel: "Arrow Down" },
    {
      label: "Paste",
      ariaLabel: "Paste from clipboard",
      input: async () => {
        const text = await readClipboard()
        if (text) {
          onInput(text)
        } else {
          setShowPasteInput(true)
          requestAnimationFrame(() => pasteRef.current?.focus())
        }
      },
    },
    { label: "Esc", input: "\x1b", ariaLabel: "Send Escape" },
    { label: "^D", input: ctrl("D"), ariaLabel: "Send Ctrl+D (EOF)" },
  ]

  function handlePress(key: KeyDef) {
    if (typeof key.input === "function") {
      key.input()
    } else {
      onInput(key.input)
    }
    // Refocus terminal after key press so the software keyboard stays up
    termRef.current?.focus()
  }

  function submitPaste() {
    const text = pasteRef.current?.value
    if (text) onInput(text)
    setShowPasteInput(false)
    termRef.current?.focus()
  }

  return (
    <div className="md:hidden">
      <div className="flex gap-1.5 overflow-x-auto border-t border-border bg-muted px-2 py-1.5">
        {keys.map((key) => (
          <button
            key={key.label}
            onTouchStart={(e) => {
              e.preventDefault()
              handlePress(key)
            }}
            onMouseDown={(e) => {
              e.preventDefault()
              handlePress(key)
            }}
            aria-label={key.ariaLabel ?? key.label}
            className="shrink-0 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground outline-none active:bg-card active:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
          >
            {key.label}
          </button>
        ))}
      </div>
      {showPasteInput && (
        <div className="flex items-center gap-2 border-t border-border bg-muted px-2 py-1.5">
          <textarea
            ref={pasteRef}
            rows={1}
            placeholder="Paste here, then tap Send"
            className="min-h-[32px] flex-1 resize-none rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
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
            className="shrink-0"
          >
            Send
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setShowPasteInput(false)
              termRef.current?.focus()
            }}
            aria-label="Cancel paste"
            className="shrink-0"
          >
            ✕
          </Button>
        </div>
      )}
    </div>
  )
}
