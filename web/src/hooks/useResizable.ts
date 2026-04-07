import { useCallback, useEffect, useRef } from "react"

interface UseResizableOptions {
  onResize: (delta: number) => void
}

// Module-level lock: only one resize handle can be active at a time.
// Stores the ref of the currently-active hook so other hooks ignore events.
const activeInstance: { current: symbol | null } = { current: null }

export function useResizable({ onResize }: UseResizableOptions) {
  const id = useRef(Symbol())
  const dragging = useRef(false)
  const startX = useRef(0)
  const pointerId = useRef<number | null>(null)

  const resetDragState = useCallback(() => {
    if (pointerId.current !== null) {
      try { document.documentElement.releasePointerCapture?.(pointerId.current) } catch { /* already released */ }
    }
    dragging.current = false
    pointerId.current = null
    if (activeInstance.current === id.current) {
      activeInstance.current = null
    }
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault()
    // If another instance is dragging, ignore
    if (activeInstance.current !== null && activeInstance.current !== id.current) return
    dragging.current = true
    pointerId.current = e.pointerId
    startX.current = e.clientX
    activeInstance.current = id.current
    // Capture on documentElement (never unmounts) so events continue outside viewport
    document.documentElement.setPointerCapture?.(e.pointerId)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }, [])

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging.current) return
      if (activeInstance.current !== id.current) return
      if (pointerId.current !== null && e.pointerId !== pointerId.current) return
      // Detect missed pointerup: if no buttons are pressed (mouse) the drag is stale
      if (e.pointerType === "mouse" && e.buttons === 0) {
        resetDragState()
        return
      }
      const delta = e.clientX - startX.current
      startX.current = e.clientX
      onResize(delta)
    }
    const onPointerUp = (e: PointerEvent) => {
      if (!dragging.current) return
      if (pointerId.current !== null && e.pointerId !== pointerId.current) return
      resetDragState()
    }

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    window.addEventListener("pointercancel", onPointerUp)

    return () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      window.removeEventListener("pointercancel", onPointerUp)
      resetDragState()
    }
  }, [onResize, resetDragState])

  return { onPointerDown }
}
