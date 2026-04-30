import { Window } from "happy-dom"

const win = new Window({ url: "http://localhost" })

const globals = ["document", "window", "navigator", "HTMLElement", "Element", "Node", "Text",
  "DocumentFragment", "Event", "CustomEvent", "MutationObserver", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout",
  "SyntaxError", "TypeError", "RangeError", "localStorage", "sessionStorage",
  "customElements"] as const

for (const key of globals) {
  if (key in win) {
    Object.defineProperty(globalThis, key, {
      value: (win as unknown as Record<string, unknown>)[key],
      writable: true,
      configurable: true,
    })
  }
}

// Polyfill ResizeObserver for @tanstack/react-virtual in tests
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    private cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) { this.cb = cb }
    observe(target: Element) {
      // Defer like the browser to avoid triggering React state updates during mount
      const cb = this.cb
      const self = this
      requestAnimationFrame(() => {
        const rect = { x: 0, y: 0, width: 800, height: 600, top: 0, right: 800, bottom: 600, left: 0 }
        cb([{ target, contentRect: rect, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry], self)
      })
    }
    unobserve() {}
    disconnect() {}
  }
}

// Polyfill DOMRect for floating-ui / base-ui positioning in tests
if (!globalThis.DOMRect) {
  globalThis.DOMRect = class DOMRect {
    x: number; y: number; width: number; height: number
    top: number; right: number; bottom: number; left: number
    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x; this.y = y; this.width = width; this.height = height
      this.top = y; this.right = x + width; this.bottom = y + height; this.left = x
    }
    toJSON() { return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left } }
    static fromRect(rect?: { x?: number; y?: number; width?: number; height?: number }) {
      return new DOMRect(rect?.x, rect?.y, rect?.width, rect?.height)
    }
  } as unknown as typeof globalThis.DOMRect
}

// happy-dom elements have 0 dimensions — provide defaults so virtualizers work
const _origGetBCR = (globalThis as unknown as Record<string, unknown>).Element
  ? Element.prototype.getBoundingClientRect
  : undefined
if (_origGetBCR) {
  Element.prototype.getBoundingClientRect = function () {
    const r = _origGetBCR.call(this)
    // If happy-dom returned all zeros, provide sensible defaults
    if (r.width === 0 && r.height === 0) {
      return Object.assign(Object.create(DOMRect.prototype), { ...r, width: 800, height: 600, right: 800, bottom: 600 }) as DOMRect
    }
    return r
  }
}

// Provide non-zero clientHeight/offsetHeight for virtualizer scroll containers
// happy-dom defines these on HTMLElement.prototype, so override there
for (const prop of ["clientHeight", "offsetHeight", "clientWidth", "offsetWidth"] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    get() { return prop.includes("Height") ? 600 : 800 },
    configurable: true,
  })
}

// Ensure scrollTo exists (used by virtualizer)
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function () {}
}
