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

export function TerminalToolbar({ termRef, onInput }: TerminalToolbarProps) {
  const keys: KeyDef[] = [
    { label: "Ctrl-C", input: ctrl("C"), ariaLabel: "Send Ctrl+C (interrupt)" },
    { label: "Ctrl-D", input: ctrl("D"), ariaLabel: "Send Ctrl+D (EOF)" },
    { label: "Ctrl-Z", input: ctrl("Z"), ariaLabel: "Send Ctrl+Z (suspend)" },
    { label: "Tab", input: "\t", ariaLabel: "Send Tab (autocomplete)" },
    { label: "Esc", input: "\x1b", ariaLabel: "Send Escape" },
    { label: "↑", input: "\x1b[A", ariaLabel: "Arrow Up" },
    { label: "↓", input: "\x1b[B", ariaLabel: "Arrow Down" },
    { label: "←", input: "\x1b[D", ariaLabel: "Arrow Left" },
    { label: "→", input: "\x1b[C", ariaLabel: "Arrow Right" },
    { label: "^A", input: ctrl("A"), ariaLabel: "Send Ctrl+A (start of line)" },
    { label: "^E", input: ctrl("E"), ariaLabel: "Send Ctrl+E (end of line)" },
    { label: "^L", input: ctrl("L"), ariaLabel: "Send Ctrl+L (clear screen)" },
    {
      label: "Paste",
      ariaLabel: "Paste from clipboard",
      input: async () => {
        try {
          const text = await navigator.clipboard.readText()
          if (text) onInput(text)
        } catch {
          // Clipboard API unavailable or permission denied
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

  return (
    <div className="flex gap-1.5 overflow-x-auto border-b border-edge bg-surface-secondary px-2 py-1.5 md:hidden">
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
  )
}
