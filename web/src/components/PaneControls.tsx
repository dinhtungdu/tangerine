import type { ReactNode, MouseEvent } from "react"

export function ResizeHandle({ onMouseDown }: { onMouseDown: (e: MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="flex w-0.5 shrink-0 cursor-col-resize bg-edge transition-colors hover:bg-blue-400"
    >
      <span />
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
