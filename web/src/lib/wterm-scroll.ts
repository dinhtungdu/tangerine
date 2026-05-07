type WTermInput = {
  onData?: (data: string) => void
}

type WTermScrollTarget = {
  element: HTMLElement
  input?: WTermInput | null
  onData?: ((data: string) => void) | null
  write?: (data: string) => void
  _scrollToBottom?: () => void
  _isScrolledToBottom?: () => boolean
}

function isPatchableWTerm(instance: unknown): instance is WTermScrollTarget {
  if (!instance || typeof instance !== "object") return false
  const target = instance as Partial<WTermScrollTarget>
  return target.element instanceof HTMLElement
}

export function patchWTermScrollBehavior(instance: unknown): boolean {
  if (!isPatchableWTerm(instance)) return false

  instance._scrollToBottom = function (this: WTermScrollTarget) {
    const max = this.element.scrollHeight - this.element.clientHeight
    this.element.scrollTop = max <= 0 ? 0 : max
  }

  instance._isScrolledToBottom = function (this: WTermScrollTarget) {
    const el = this.element
    return el.scrollHeight - el.scrollTop - el.clientHeight < 30
  }

  if (instance.input) {
    // WTerm scrolls before forwarding each input byte; with scrollback this
    // moves the viewport before the echoed output arrives.
    instance.input.onData = (data: string) => {
      if (instance.onData) {
        instance.onData(data)
      } else {
        instance.write?.(data)
      }
    }
  }

  return true
}
