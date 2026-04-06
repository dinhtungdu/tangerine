import { useCallback, useEffect, useRef } from "react"

interface UseResizableOptions {
  onResize: (delta: number) => void
}

export function useResizable({ onResize }: UseResizableOptions) {
  const dragging = useRef(false)
  const startX = useRef(0)
  const pointerId = useRef<number | null>(null)

  const resetDragState = useCallback(() => {
    dragging.current = false
    pointerId.current = null
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault()
    dragging.current = true
    pointerId.current = e.pointerId
    startX.current = e.clientX
    e.currentTarget.setPointerCapture?.(e.pointerId)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }, [])

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging.current) return
      if (pointerId.current !== null && e.pointerId !== pointerId.current) return
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
