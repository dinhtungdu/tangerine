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

export function PaneToggle({ desktopActive, mobileActive, onClick, label, disabled, children }: {
  desktopActive: boolean
  mobileActive: boolean
  onClick: () => void
  label: string
  disabled?: boolean
  children: ReactNode
}) {
  const activeClass = "border border-edge bg-surface-secondary text-fg shadow-sm"
  const inactiveClass = "text-fg-muted"
  const disabledClass = "opacity-30 cursor-not-allowed"

  return (
    <>
      <button
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        aria-label={label}
        title={label}
        className={`hidden h-7 w-8 items-center justify-center rounded-md md:flex ${disabled ? disabledClass : desktopActive ? activeClass : inactiveClass}`}
      >
        {children}
      </button>
      <button
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        aria-label={label}
        title={label}
        className={`flex h-7 w-8 items-center justify-center rounded-md md:hidden ${disabled ? disabledClass : mobileActive ? activeClass : inactiveClass}`}
      >
        {children}
      </button>
    </>
  )
}
