import { useEffect } from "react"
import { getActions, matchesShortcut, executeAction, subscribe } from "../lib/actions"

const PULL_THRESHOLD = 80 // px of overscroll needed to trigger

// Wait until the visual viewport is back at the origin (offsetTop/offsetLeft ≈ 0).
// On iOS, overscroll bounce temporarily shifts the visual viewport; opening a
// position:fixed overlay while it's shifted produces a distorted narrow-bar rendering.
function waitForViewportSettle(callback: () => void) {
  const vv = window.visualViewport
  if (!vv || (Math.abs(vv.offsetTop) < 1 && Math.abs(vv.offsetLeft) < 1)) {
    callback()
    return
  }
  const check = () => {
    if (Math.abs(vv.offsetTop) < 1 && Math.abs(vv.offsetLeft) < 1) {
      callback()
    } else {
      requestAnimationFrame(check)
    }
  }
  requestAnimationFrame(check)
}

/**
 * Global keyboard shortcut listener + pull-to-refresh interception.
 * Reads from the action registry and fires matching action handlers.
 * Suppresses shortcuts when focus is in a text input (unless meta key is used).
 * On touch devices, intercepts pull-down-from-top gesture to open the command palette.
 */
export function useShortcuts() {
  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      const isEditable =
        tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable
      if (isEditable && !e.metaKey && !e.ctrlKey) return

      for (const action of getActions()) {
        if (action.shortcut && matchesShortcut(e, action.shortcut)) {
          e.preventDefault()
          action.handler()
          return
        }
      }
    }

    document.addEventListener("keydown", onKeyDown)
    const unsub = subscribe(() => {})

    return () => {
      document.removeEventListener("keydown", onKeyDown)
      unsub()
    }
  }, [])

  // Pull-to-refresh → open command palette on touch devices.
  // Only triggers when both the window AND the nearest scrollable ancestor are at scroll top.
  useEffect(() => {
    let startY = 0
    let tracking = false

    function isAtScrollTop(el: Element | null): boolean {
      let node = el
      while (node && node !== document.documentElement) {
        if (node.scrollHeight > node.clientHeight && node.scrollTop > 0) return false
        node = node.parentElement
      }
      return window.scrollY === 0
    }

    function onTouchStart(e: TouchEvent) {
      // Stop tracking if a second finger appears (e.g. pinch-zoom)
      if (e.touches.length !== 1) { tracking = false; return }
      if (!isAtScrollTop(e.target as Element)) return
      startY = e.touches[0]!.clientY
      tracking = true
    }

    function onTouchMove(e: TouchEvent) {
      if (!tracking) return
      // Skip multi-touch — don't interfere with pinch-zoom or other gestures
      if (e.touches.length !== 1) { tracking = false; return }
      const delta = e.touches[0]!.clientY - startY
      // Prevent iOS overscroll bounce while we're handling a downward pull.
      // Without this, the visual viewport shifts during the animation and the
      // fixed-position command palette renders as a distorted narrow bar.
      if (delta > 0) e.preventDefault()
    }

    function onTouchEnd(e: TouchEvent) {
      if (!tracking) return
      tracking = false
      const endY = e.changedTouches[0]!.clientY
      const delta = endY - startY
      if (delta >= PULL_THRESHOLD && isAtScrollTop(e.target as Element)) {
        // On iOS, the visual viewport may still be offset due to overscroll bounce
        // when touchend fires. Wait for it to settle before opening the fixed overlay,
        // otherwise the palette renders as a distorted narrow bar.
        waitForViewportSettle(() => executeAction("palette.open"))
      }
    }

    document.addEventListener("touchstart", onTouchStart, { passive: true })
    // Non-passive so we can preventDefault() the iOS overscroll bounce
    document.addEventListener("touchmove", onTouchMove, { passive: false })
    document.addEventListener("touchend", onTouchEnd, { passive: true })

    return () => {
      document.removeEventListener("touchstart", onTouchStart)
      document.removeEventListener("touchmove", onTouchMove)
      document.removeEventListener("touchend", onTouchEnd)
    }
  }, [])
}
