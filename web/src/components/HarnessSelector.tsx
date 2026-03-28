import { useState, useRef, useEffect } from "react"
import type { ProviderType } from "@tangerine/shared"

interface HarnessSelectorProps {
  value: ProviderType
  onChange: (value: ProviderType) => void
}

const harnesses: { value: ProviderType; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
  { value: "codex", label: "Codex" },
]

export function HarnessSelector({ value, onChange }: HarnessSelectorProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

  const current = harnesses.find((h) => h.value === value) ?? harnesses[0]!

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md border border-edge bg-surface-secondary px-2 py-1 transition hover:bg-surface"
      >
        <svg className="h-3 w-3 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m5.25 4.5 7.5 7.5-7.5 7.5m6 0h6.75" />
        </svg>
        <span className="text-[11px] font-medium text-fg">{current.label}</span>
        <svg
          className={`h-2.5 w-2.5 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[160px] overflow-hidden rounded-lg border border-edge bg-surface-card shadow-lg">
          {harnesses.map((h) => {
            const isActive = h.value === value
            return (
              <button
                key={h.value}
                onClick={() => {
                  onChange(h.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-[12px] transition ${
                  isActive ? "bg-surface-secondary font-medium text-fg" : "text-fg-muted hover:bg-surface"
                }`}
              >
                <div className="flex items-center gap-2">
                  <svg className="h-3 w-3 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m5.25 4.5 7.5 7.5-7.5 7.5m6 0h6.75" />
                  </svg>
                  <span>{h.label}</span>
                </div>
                {isActive && (
                  <svg className="h-3 w-3 text-fg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
