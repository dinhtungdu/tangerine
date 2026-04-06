import type { PointerEvent, ReactNode } from "react"

export function ResizeHandle({ onPointerDown, className }: { onPointerDown: (e: PointerEvent<HTMLDivElement>) => void; className?: string }) {
  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      className={`group relative flex w-3 shrink-0 touch-none cursor-col-resize items-stretch justify-center${className ? ` ${className}` : ""}`}
    >
      <span className="pointer-events-none my-0.5 w-px rounded-full bg-edge transition-colors group-hover:bg-accent" />
    </div>
  )
}

export function PaneToggle({ desktopActive, mobileActive, onClick, label, children }: {
  desktopActive: boolean
  mobileActive: boolean
  onClick: () => void
  label: string
  children: ReactNode
}) {
  const activeClass = "border border-edge bg-surface-secondary text-fg shadow-sm"
  const inactiveClass = "text-fg-muted"

  return (
    <>
      <button
        onClick={onClick}
        aria-label={label}
        className={`hidden h-7 w-8 items-center justify-center rounded-md md:flex ${desktopActive ? activeClass : inactiveClass}`}
      >
        {children}
      </button>
      <button
        onClick={onClick}
        aria-label={label}
        className={`flex h-7 w-8 items-center justify-center rounded-md md:hidden ${mobileActive ? activeClass : inactiveClass}`}
      >
        {children}
      </button>
    </>
  )
}
