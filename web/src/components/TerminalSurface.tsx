import type { ReactNode } from "react"

export const TERMINAL_EMULATOR_CLASS_NAME = "absolute inset-0 bg-card p-1"
export const TERMINAL_OVERLAY_CLASS_NAME = "absolute inset-0 flex items-center justify-center bg-[#1a1a1a]"

interface TerminalSurfaceProps {
  children: ReactNode
  overlay?: ReactNode
}

export function TerminalSurface({ children, overlay }: TerminalSurfaceProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 p-3">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg bg-card">
        {children}
        {overlay}
      </div>
    </div>
  )
}
