import { useState, useRef, useEffect } from "react"
import type { ProviderType } from "@tangerine/shared"

interface EffortOption {
  value: string
  label: string
  description: string
}

const CLAUDE_CODE_EFFORTS: EffortOption[] = [
  { value: "low", label: "Low", description: "Quick, minimal thinking" },
  { value: "medium", label: "Medium", description: "Balanced (default)" },
  { value: "high", label: "High", description: "Extended reasoning" },
  { value: "max", label: "Max", description: "Maximum reasoning depth" },
]

const CODEX_EFFORTS: EffortOption[] = [
  { value: "none", label: "None", description: "No reasoning" },
  { value: "minimal", label: "Minimal", description: "Brief reasoning" },
  { value: "low", label: "Low", description: "Quick, minimal thinking" },
  { value: "medium", label: "Medium", description: "Balanced (default)" },
  { value: "high", label: "High", description: "Extended reasoning" },
  { value: "xhigh", label: "Extra High", description: "Maximum reasoning depth" },
]

const PI_EFFORTS: EffortOption[] = [
  { value: "off", label: "Off", description: "No thinking" },
  { value: "minimal", label: "Minimal", description: "Brief reasoning" },
  { value: "low", label: "Low", description: "Quick, minimal thinking" },
  { value: "medium", label: "Medium", description: "Balanced (default)" },
  { value: "high", label: "High", description: "Extended reasoning" },
  { value: "xhigh", label: "Extra High", description: "Maximum reasoning depth" },
]

const DEFAULT_EFFORTS: EffortOption[] = [
  { value: "low", label: "Low", description: "Quick, minimal thinking" },
  { value: "medium", label: "Medium", description: "Balanced (default)" },
  { value: "high", label: "High", description: "Extended reasoning" },
]

export function getEfforts(provider?: ProviderType): EffortOption[] {
  switch (provider) {
    case "claude-code": return CLAUDE_CODE_EFFORTS
    case "codex": return CODEX_EFFORTS
    case "pi": return PI_EFFORTS
    default: return DEFAULT_EFFORTS
  }
}

export type ReasoningEffort = string

interface ReasoningEffortSelectorProps {
  value: ReasoningEffort
  onChange: (value: ReasoningEffort) => void
  provider?: ProviderType
}

export function ReasoningEffortSelector({ value, onChange, provider }: ReasoningEffortSelectorProps) {
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

  const efforts = getEfforts(provider)
  const current = efforts.find((e) => e.value === value) ?? efforts.find((e) => e.value === "medium") ?? efforts[0]!

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md border border-edge bg-surface-secondary px-2 py-1 transition hover:bg-surface"
      >
        <svg className="h-3 w-3 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
        </svg>
        <span className="text-xxs font-medium text-fg">{current.label}</span>
        <svg
          className={`h-2.5 w-2.5 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[180px] overflow-hidden rounded-lg border border-edge bg-surface-card shadow-lg">
          {efforts.map((e) => {
            const isActive = e.value === value
            return (
              <button
                key={e.value}
                onClick={() => {
                  onChange(e.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center justify-between px-3 py-2 text-left transition ${
                  isActive ? "bg-surface-secondary" : "hover:bg-surface"
                }`}
              >
                <div className="flex flex-col">
                  <span className={`text-xs ${isActive ? "font-medium text-fg" : "text-fg-muted"}`}>
                    {e.label}
                  </span>
                  <span className="text-2xs text-fg-muted">{e.description}</span>
                </div>
                {isActive && (
                  <svg className="h-3 w-3 shrink-0 text-fg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
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
