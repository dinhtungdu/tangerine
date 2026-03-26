import { useState, useRef, useEffect, useCallback } from "react"
import { useProject } from "../context/ProjectContext"
import { formatModelName } from "../lib/format"
import { searchModels } from "../lib/model-search"

interface ModelSelectorProps {
  /** Override the model list (e.g. filtered by provider) */
  models?: string[]
  /** Override the currently selected model */
  model?: string
  /** Override the model change handler */
  onModelChange?: (model: string) => void
  /** Controls whether the menu opens above or below the trigger */
  menuPlacement?: "top" | "bottom"
}

export function ModelSelector({ models: propModels, model: propModel, onModelChange, menuPlacement = "top" }: ModelSelectorProps = {}) {
  const ctx = useProject()
  const models = propModels ?? ctx.models
  const model = propModel ?? ctx.model
  const setModel = onModelChange ?? ctx.setModel
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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

  // Focus search input when dropdown opens, clear search on close
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0)
    } else {
      setSearch("")
    }
  }, [open])

  const filtered = searchModels(models, search)

  const handleSelect = useCallback((m: string) => {
    setModel(m)
    setOpen(false)
  }, [setModel])

  if (!model || !models.length) return null

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md border border-edge px-2 py-1 transition hover:bg-surface-secondary"
      >
        <svg className="h-3 w-3 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
        </svg>
        <span className="text-[11px] font-medium text-fg">{formatModelName(model)}</span>
        <svg
          className={`h-2.5 w-2.5 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && models.length > 0 && (
        <div className={`absolute left-0 z-50 min-w-[260px] overflow-hidden rounded-lg border border-edge bg-surface-card shadow-lg ${menuPlacement === "bottom" ? "top-full mt-1" : "bottom-full mb-1"}`}>
          {models.length > 5 && (
            <div className="border-b border-edge px-2 py-1.5">
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search models..."
                className="w-full bg-transparent text-[16px] text-fg placeholder:text-fg-muted outline-none md:text-[12px]"
              />
            </div>
          )}
          <div className="max-h-[200px] overflow-y-auto md:max-h-[280px]">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-fg-muted">No models match</div>
            ) : (
              filtered.map((m) => {
                const isActive = m === model
                return (
                  <button
                    key={m}
                    onClick={() => handleSelect(m)}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-[12px] transition ${
                      isActive ? "bg-surface-secondary font-medium text-fg" : "text-fg-muted hover:bg-surface"
                    }`}
                  >
                    <span>{formatModelName(m)}</span>
                    {isActive && (
                      <svg className="h-3 w-3 text-fg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                      </svg>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
