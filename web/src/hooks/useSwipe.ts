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
}

/**
 * Attaches touch-based swipe detection to a container ref.
 * Returns onTouchStart / onTouchEnd props to spread onto the element.
 */
export function useSwipe(
  handlers: SwipeHandlers,
  options: SwipeOptions = {},
) {
  const { threshold = 50, maxVertical = 80 } = options
  const startRef = useRef<{ x: number; y: number } | null>(null)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    if (!touch) return
    startRef.current = { x: touch.clientX, y: touch.clientY }
  }, [])

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!startRef.current) return
    const touch = e.changedTouches[0]
    if (!touch) return
    const dx = touch.clientX - startRef.current.x
    const dy = touch.clientY - startRef.current.y
    startRef.current = null

    if (Math.abs(dy) > maxVertical) return
    if (Math.abs(dx) < threshold) return

    if (dx < 0) {
      handlers.onSwipeLeft?.()
    } else {
      handlers.onSwipeRight?.()
    }
  }, [handlers, threshold, maxVertical])

  return { onTouchStart, onTouchEnd }
}
