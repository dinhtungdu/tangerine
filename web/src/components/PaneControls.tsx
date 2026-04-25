import type { PointerEvent, ReactNode, Ref } from "react"
import type { PaneId } from "../lib/panes"

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

const PANE_ICONS: Record<PaneId, ReactNode> = {
  chat: (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  diff: (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7M11 18H8a2 2 0 0 1-2-2V9" />
    </svg>
  ),
  terminal: (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3" />
      <rect x="2" y="3" width="20" height="18" rx="2" />
    </svg>
  ),
  tree: (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 1 0 3 3m-3-3a3 3 0 0 1 3 3m0 0h6a3 3 0 0 0 3-3V9m0 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
    </svg>
  ),
  activity: (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
}

const PANE_LABELS: Record<PaneId, string> = {
  chat: "Chat",
  diff: "Diff",
  terminal: "Terminal",
  tree: "Tree",
  activity: "Activity",
}

export function MobileTabBar({
  panes,
  activePane,
  onSelect,
  probeRef,
}: {
  panes: PaneId[]
  activePane: PaneId
  onSelect: (pane: PaneId) => void
  probeRef?: Ref<HTMLButtonElement>
}) {
  return (
    <nav className="flex h-12 shrink-0 items-center justify-around border-t border-border bg-background md:hidden">
      {panes.map((pane, idx) => {
        const isActive = pane === activePane
        return (
          <button
            key={pane}
            ref={idx === 0 ? probeRef : undefined}
            onClick={() => onSelect(pane)}
            aria-label={PANE_LABELS[pane]}
            aria-current={isActive ? "page" : undefined}
            className={`flex h-11 min-w-[44px] flex-1 flex-col items-center justify-center gap-0.5 outline-none focus-visible:ring-1 focus-visible:ring-ring/50 ${
              isActive ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {PANE_ICONS[pane]}
            <span className="text-2xs">{PANE_LABELS[pane]}</span>
          </button>
        )
      })}
    </nav>
  )
}
