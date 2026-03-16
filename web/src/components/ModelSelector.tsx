import { useState, useRef, useEffect } from "react"
import { useProject } from "../context/ProjectContext"
import { formatModelName } from "../lib/format"

export function ModelSelector() {
  const { model, models, setModel } = useProject()
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

  if (!model) return null

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md border border-[#e5e5e5] px-2 py-1 transition hover:bg-[#f5f5f5]"
      >
        <svg className="h-3 w-3 text-[#737373]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
        </svg>
        <span className="text-[11px] font-medium text-[#0a0a0a]">{formatModelName(model)}</span>
        <svg
          className={`h-2.5 w-2.5 text-[#737373] transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && models.length > 0 && (
        <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[200px] overflow-hidden rounded-lg border border-[#e5e5e5] bg-white shadow-lg">
          {models.map((m) => {
            const isActive = m === model
            return (
              <button
                key={m}
                onClick={() => {
                  setModel(m)
                  setOpen(false)
                }}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-[12px] transition ${
                  isActive ? "bg-[#f5f5f5] font-medium text-[#0a0a0a]" : "text-[#555] hover:bg-[#fafafa]"
                }`}
              >
                <span>{formatModelName(m)}</span>
                {isActive && (
                  <svg className="h-3 w-3 text-[#0a0a0a]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
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
