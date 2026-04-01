import { useEffect } from "react"
import { getActions, matchesShortcut, executeAction, subscribe } from "../lib/actions"

const PULL_THRESHOLD = 80 // px of overscroll needed to trigger

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
      if (!isAtScrollTop(e.target as Element)) return
      startY = e.touches[0]!.clientY
      tracking = true
    }

    function onTouchEnd(e: TouchEvent) {
      if (!tracking) return
      tracking = false
      const endY = e.changedTouches[0]!.clientY
      const delta = endY - startY
      if (delta >= PULL_THRESHOLD && isAtScrollTop(e.target as Element)) {
        executeAction("palette.open")
      }
    }

    document.addEventListener("touchstart", onTouchStart, { passive: true })
    document.addEventListener("touchend", onTouchEnd, { passive: true })

    return () => {
      document.removeEventListener("touchstart", onTouchStart)
      document.removeEventListener("touchend", onTouchEnd)
    }
  }, [])
}
