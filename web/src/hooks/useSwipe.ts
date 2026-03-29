import { useRef, useCallback } from "react"

interface SwipeHandlers {
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
}

interface SwipeOptions {
  /** Minimum horizontal distance (px) to trigger a swipe. Default: 50 */
  threshold?: number
  /** Max vertical distance (px) allowed — prevents triggering on scrolls. Default: 80 */
  maxVertical?: number
  /** Only trigger swipe when touch starts within this many px of screen edge. Default: undefined (anywhere) */
  edgeWidth?: number
}

/** Walk up from `el` to check if any ancestor can scroll horizontally. */
function hasHorizontalScroll(el: HTMLElement): boolean {
  let node: HTMLElement | null = el
  while (node) {
    if (node.scrollWidth > node.clientWidth) return true
    node = node.parentElement
  }
  return false
}

/**
 * Returns onTouchStart / onTouchEnd props to spread onto an element
 * for horizontal swipe detection. Uses a ref for handlers so the
 * returned callbacks are stable regardless of caller memoization.
 */
export function useSwipe(
  handlers: SwipeHandlers,
  options: SwipeOptions = {},
) {
  const { threshold = 50, maxVertical = 80, edgeWidth } = options
  const startRef = useRef<{ x: number; y: number; edge?: "right" } | null>(null)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    if (!touch) return
    // Only accept touches starting near right screen edge.
    // Left edge is reserved for the browser's native back gesture.
    let edge: "right" | undefined
    if (edgeWidth != null) {
      const x = touch.clientX
      const screenW = document.documentElement.clientWidth
      if (x >= screenW - edgeWidth) edge = "right"
      else return
    }
    // Ignore touches on interactive or horizontally-scrollable elements
    const el = e.target as HTMLElement
    const tag = el.tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return
    if (el.closest("[data-swipe-ignore]")) return
    // Skip if touch started inside a horizontally-scrollable container
    if (hasHorizontalScroll(el)) return
    startRef.current = { x: touch.clientX, y: touch.clientY, edge }
  }, [edgeWidth])

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!startRef.current) return
    const touch = e.changedTouches[0]
    if (!touch) return
    const dx = touch.clientX - startRef.current.x
    const dy = touch.clientY - startRef.current.y
    const { edge } = startRef.current
    startRef.current = null

    if (Math.abs(dy) > maxVertical) return
    if (Math.abs(dx) < threshold) return

    if (edge) {
      // Right edge swipe → onSwipeRight (next pane)
      // Left edge is not handled — browser native back gesture
      handlersRef.current.onSwipeRight?.()
    } else {
      if (dx < 0) handlersRef.current.onSwipeLeft?.()
      else handlersRef.current.onSwipeRight?.()
    }
  }, [threshold, maxVertical])

  return { onTouchStart, onTouchEnd }
}
