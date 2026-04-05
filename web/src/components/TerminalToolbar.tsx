import { useState, useRef as useReactRef } from "react"
import type { Terminal } from "@xterm/xterm"

interface TerminalToolbarProps {
  termRef: React.RefObject<Terminal | null>
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
    { label: "^D", input: ctrl("D"), ariaLabel: "Send Ctrl+D (EOF)" },
    { label: "^Z", input: ctrl("Z"), ariaLabel: "Send Ctrl+Z (suspend)" },
    { label: "Tab", input: "\t", ariaLabel: "Send Tab (autocomplete)" },
    { label: "Esc", input: "\x1b", ariaLabel: "Send Escape" },
    { label: "↑", input: "\x1b[A", ariaLabel: "Arrow Up" },
    { label: "↓", input: "\x1b[B", ariaLabel: "Arrow Down" },
    { label: "←", input: "\x1b[D", ariaLabel: "Arrow Left" },
    { label: "→", input: "\x1b[C", ariaLabel: "Arrow Right" },
    { label: "^A", input: ctrl("A"), ariaLabel: "Send Ctrl+A (start of line)" },
    { label: "^E", input: ctrl("E"), ariaLabel: "Send Ctrl+E (end of line)" },
    { label: "^L", input: ctrl("L"), ariaLabel: "Send Ctrl+L (clear screen)" },
    { label: "^O", input: ctrl("O"), ariaLabel: "Send Ctrl+O (write out in nano)" },
    { label: "^X", input: ctrl("X"), ariaLabel: "Send Ctrl+X (exit nano)" },
    {
      label: "Paste",
      ariaLabel: "Paste from clipboard",
      input: async () => {
        const text = await readClipboard()
        if (text) {
          onInput(text)
        } else {
          // Clipboard API unavailable (HTTP) — show textarea for manual paste
          setShowPasteInput(true)
          // Focus the textarea on next frame so the user can long-press paste
          requestAnimationFrame(() => pasteRef.current?.focus())
        }
      },
    },
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
      <div className="flex gap-1.5 overflow-x-auto border-t border-edge bg-surface-secondary px-2 py-1.5">
        {keys.map((key) => (
          <button
            key={key.label}
            onPointerDown={(e) => {
              // Prevent stealing focus from terminal / dismissing keyboard
              e.preventDefault()
              handlePress(key)
            }}
            aria-label={key.ariaLabel ?? key.label}
            className="shrink-0 rounded-md border border-edge bg-surface px-2 py-1 text-xs font-medium text-fg-muted active:bg-surface-card active:text-fg"
          >
            {key.label}
          </button>
        ))}
      </div>
      {showPasteInput && (
        <div className="flex items-center gap-2 border-t border-edge bg-surface-secondary px-2 py-1.5">
          <textarea
            ref={pasteRef}
            rows={1}
            placeholder="Paste here, then tap Send"
            className="min-h-[32px] flex-1 resize-none rounded-md border border-edge bg-surface px-2 py-1 text-xs text-fg placeholder:text-fg-muted"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                submitPaste()
              }
            }}
          />
          <button
            onClick={submitPaste}
            className="shrink-0 rounded-md bg-accent px-3 py-1 text-xs font-medium text-white active:opacity-80"
          >
            Send
          </button>
          <button
            onClick={() => {
              setShowPasteInput(false)
              termRef.current?.focus()
            }}
            aria-label="Cancel paste"
            className="shrink-0 rounded-md border border-edge bg-surface px-2 py-1 text-xs text-fg-muted active:bg-surface-card"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
