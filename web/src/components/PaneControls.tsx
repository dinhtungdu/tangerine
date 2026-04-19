import type { PointerEvent, ReactNode, Ref } from "react"

export function ResizeHandle({ onPointerDown, className }: { onPointerDown: (e: PointerEvent<HTMLDivElement>) => void; className?: string }) {
  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      className={`group relative flex w-px shrink-0 touch-none cursor-col-resize items-stretch justify-center${className ? ` ${className}` : ""}`}
    >
		  <span className="pointer-events-none my-0.5 w-px rounded-full bg-border transition-colors group-hover:bg-accent" />
		  <span className="absolute w-3 left-0 top-0 bottom-0 -translate-x-1/2" />
    </div>
  )
}

export function PaneToggle({
  desktopActive,
  mobileActive,
  onDesktopClick,
  onMobileClick,
  label,
  disabled,
  desktopButtonRef,
  mobileButtonRef,
  children,
}: {
  desktopActive: boolean
  mobileActive: boolean
  onDesktopClick: () => void
  onMobileClick: () => void
  label: string
  disabled?: boolean
  desktopButtonRef?: Ref<HTMLButtonElement>
  mobileButtonRef?: Ref<HTMLButtonElement>
  children: ReactNode
}) {
  const activeClass = "border border-border bg-muted text-foreground shadow-sm"
  const inactiveClass = "text-muted-foreground"
  const disabledClass = "opacity-30 cursor-not-allowed"

  return (
    <>
      <button
        ref={desktopButtonRef}
        onClick={disabled ? undefined : onDesktopClick}
        disabled={disabled}
        aria-label={label}
        title={label}
        className={`hidden h-7 w-8 items-center justify-center rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring/50 md:flex ${disabled ? disabledClass : desktopActive ? activeClass : inactiveClass}`}
      >
        {children}
      </button>
      <button
        ref={mobileButtonRef}
        onClick={disabled ? undefined : onMobileClick}
        disabled={disabled}
        aria-label={label}
        title={label}
        className={`flex h-7 w-8 items-center justify-center rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring/50 md:hidden ${disabled ? disabledClass : mobileActive ? activeClass : inactiveClass}`}
      >
        {children}
      </button>
    </>
  )
}
